import { Hono } from "hono";
import { store, getSetting } from "../db";
import { tailRendered, readAll, insertLogLines, LOG_TAIL_LIMIT, LOG_EXPORT_LIMIT } from "../log";
import { engineState } from "../engine";
import { readErrorRows, renderErrorCards } from "../errorrows";
import { Rclone } from "../rclone";
import { isSafeRel, parseTrashSubdir, normalizeRel, TRASH } from "../archive";
import {
  registerDownload,
  activeDownloadCount,
} from "../downloads";

export const logsapi = new Hono();

async function latestRunId(): Promise<number> {
  if (engineState.running && engineState.runId > 0) return engineState.runId;
  const setting = Number((await getSetting("last_run_id", "0")) ?? "0");
  if (setting > 0) return setting;
  const row = await store.get1<{ id: number | string }>(
    "SELECT id FROM runs ORDER BY id DESC LIMIT 1",
  );
  return Number(row?.id ?? 0);
}

function kindOf(value: string | undefined): "main" | "errors" {
  return value === "errors" ? "errors" : "main";
}

function noStore(c: { header: (name: string, value: string) => void }): void {
  c.header("Cache-Control", "no-store");
}

logsapi.get("/logs/fragment", async (c) => {
  const kind = kindOf(c.req.query("kind"));
  noStore(c);

  let runId = Number(c.req.query("run") ?? "");
  if (!Number.isFinite(runId) || runId <= 0) runId = await latestRunId();
  if (runId > 0 && engineState.running && engineState.runId > 0) {
    runId = engineState.runId;
  }
  const afterId = Number(c.req.query("after") ?? "0");
  const cursor = Number.isFinite(afterId) && afterId > 0 ? afterId : 0;

  if (!runId) {
    return c.json({
      runId: 0,
      entries: [],
      lastId: cursor,
      live: false,
      finishedAt: "",
      message: "No runs yet.",
    });
  }

  const { entries, lastId } = await tailRendered(
    { scope: "run", refId: runId, kind },
    LOG_TAIL_LIMIT,
    cursor,
  );
  const live = engineState.running && engineState.runId === runId;
  let finishedAt = "";
  if (!live) {
    const row = await store.get1<{ finished_at: string | null }>(
      "SELECT finished_at FROM runs WHERE id = ?",
      [runId],
    );
    finishedAt = row?.finished_at ?? "";
  }
  return c.json({
    runId,
    entries: entries.map((e) => e.html),
    lastId,
    live,
    finishedAt,
  });
});

logsapi.get("/errors/fragment", async (c) => {
  noStore(c);
  c.header("X-Engine-Live", engineState.running ? "1" : "0");
  const rows = await readErrorRows(store);
  return c.html(renderErrorCards(rows));
});

logsapi.get("/download/run/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const kind = kindOf(c.req.query("kind"));
  if (!Number.isInteger(id) || id <= 0) return c.text("not found", 404);
  const lines = await readAll({ scope: "run", refId: id, kind });
  if (lines.length === 0) return c.text("not found", 404);
  const suffix = kind === "errors" ? "-errors" : "";
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="run-${id}${suffix}.log"`,
    },
  });
});

logsapi.get("/logs/archive/:id/fragment", async (c) => {
  noStore(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.text("not found", 404);
  const { entries } = await tailRendered(
    { scope: "archive", refId: id, kind: "extract" },
    LOG_EXPORT_LIMIT,
  );
  if (entries.length === 0) {
    return c.html(`<p class="muted">No log lines for this archive.</p>`);
  }
  return c.html(entries.map((e) => e.html).join(""));
});

logsapi.get("/download/archive/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.text("not found", 404);
  const kind = "extract" as const;
  const lines = await readAll({ scope: "archive", refId: id, kind });
  if (lines.length === 0) return c.text("not found", 404);
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="archive-${id}-${kind}.log"`,
    },
  });
});

/** Single byte-range from a `Range` header: the window, "unsatisfiable"
 * (416), or null (serve the whole file). Multi-range/garbage headers are
 * ignored per RFC 7233 instead of erroring. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return null;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (b === "") {
    start = Number(a);
    end = size - 1;
  } else {
    start = Number(a);
    end = Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

/** How many archive-file downloads are streaming right now (concurrency 1). */
logsapi.get("/download/archive-file/active", (c) => {
  noStore(c);
  return c.json({ active: activeDownloadCount() });
});

/**
 * Download the archive file itself (not its log). Streams `rclone cat`
 * straight to the client — the archive can be huge, so nothing is buffered.
 * Files already moved to trash (status='deleted') are served from there.
 *
 * Resumable: `Range` requests are answered with 206 + Content-Range (byte
 * window sliced out of the remote with `rclone cat --offset/--count`), and
 * every response advertises Accept-Ranges + Last-Modified. Archives up to
 * 32 MB are buffered and served with Content-Length; larger ones stream
 * chunked (the runtime reframes piped streams) and still carry
 * Content-Range. The size comes from one `lsjson` call (fresh, so a
 * resume never trusts a stale scan-time size); if the remote cannot tell
 * us we fall back to the stored size, then to a plain full download.
 *
 * Concurrency 1: each stream registers itself while bytes flow; the UI
 * greys every archive Download button while at least one is active. A
 * client that disconnects kills the child rclone and unregisters.
 */
logsapi.get("/download/archive-file/:id", async (c) => {
  noStore(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.text("not found", 404);
  const row = await store.get1<{ path: string; status: string; size: number | string }>(
    "SELECT path, status, size FROM archives WHERE id = ?",
    [id],
  );
  if (!row) return c.text("not found", 404);
  const rel = String(row.path);
  if (!isSafeRel(rel)) return c.text("not found", 404);
  let srcRel = rel;
  if (row.status === "deleted") {
    const trash = parseTrashSubdir((await getSetting("trash_subdir", TRASH)) ?? TRASH);
    if (!trash) return c.text("trash_subdir is invalid", 500);
    srcRel = normalizeRel(`${trash}/${rel}`);
  }
  const ref = { scope: "archive" as const, refId: id, kind: "extract" as const };
  const rc = await Rclone.fromSettings();
  let stat: { size: number; modTime?: string } | null = null;
  try {
    stat = await rc.statFile(srcRel);
  } catch {
    stat = null;
  }
  const dbSize = Number(row.size);
  const total: number | null = stat
    ? stat.size
    : Number.isFinite(dbSize) && dbSize >= 0
      ? dbSize
      : null;
  const mtime = stat?.modTime ? new Date(stat.modTime) : null;
  const lastModified =
    mtime && !Number.isNaN(mtime.getTime()) ? mtime.toUTCString() : undefined;

  // If-Range is only trusted when it matches the Last-Modified we emit —
  // anything else means "the file may have changed", so serve it fully
  // instead of resuming against bytes that are no longer there.
  let rangeHeader = c.req.header("Range");
  const ifRange = c.req.header("If-Range");
  if (ifRange && (!lastModified || ifRange.trim() !== lastModified)) {
    rangeHeader = undefined;
  }
  const range = total !== null ? parseRange(rangeHeader, total) : null;
  if (total !== null && range === "unsatisfiable") {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${total}`,
        "Accept-Ranges": "bytes",
        ...(lastModified ? { "Last-Modified": lastModified } : {}),
      },
    });
  }
  const window = range && range !== "unsatisfiable" ? range : null;
  const offset = window ? window.start : 0;
  const count = window ? window.end - window.start + 1 : 0;

  const unregister = registerDownload(id);
  let killedByClient = false;
  // Bun keeps an explicit Content-Length only for plain (in-memory) bodies —
  // a pipe-backed stream through Hono is re-framed as chunked. Buffer
  // ordinary archives so downloads resume reliably; huge ones stream, with
  // the range still conveyed by Content-Range.
  const MAX_BUFFERED = 32 * 1024 * 1024;
  const buffer = async (rs: ReadableStream): Promise<Buffer> => {
    const reader = rs.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Uint8Array);
    }
    return Buffer.concat(chunks);
  };
  try {
    const { stdout, exited, stderr, command, kill } = await rc.openCat(
      srcRel,
      window ? { offset, count } : undefined,
    );
    // Kill the child + unregister when the browser aborts the download.
    c.req.raw.signal.addEventListener("abort", () => {
      killedByClient = true;
      unregister();
      kill();
    });
    void exited.then(async (code) => {
      unregister();
      if (code !== 0 && !killedByClient) {
        const err = (await stderr.catch(() => "")).trim();
        await insertLogLines(ref, [
          ...(err ? err.split("\n") : []),
          `archive download failed (exit ${code}) [$ ${command}]`,
        ]).catch(() => {});
      }
    });
    const base = srcRel.slice(srcRel.lastIndexOf("/") + 1);
    const fallback = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/"/g, "_") || "archive";
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      ...(lastModified ? { "Last-Modified": lastModified } : {}),
    };
    if (total !== null) {
      headers["Accept-Ranges"] = "bytes";
      headers["Content-Length"] = String(window ? count : total);
      if (window) {
        headers["Content-Range"] = `bytes ${offset}-${offset + count - 1}/${total}`;
      }
    }
    const sizeWanted = window ? count : (total ?? 0);
    if (total !== null && sizeWanted <= MAX_BUFFERED) {
      const bytes = await buffer(stdout);
      return new Response(new Uint8Array(bytes), { status: window ? 206 : 200, headers });
    }
    return new Response(stdout, { status: window ? 206 : 200, headers });
  } catch (e) {
    unregister();
    return c.text(`could not start download: ${String(e)}`, 502);
  }
});
