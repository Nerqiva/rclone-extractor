import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-dl-"));
delete process.env.DATABASE_URL;

const fixture = Buffer.from("0123456789ABCDEFGHI"); // 19 bytes
const fixturePath = join(process.env.DATA_DIR, "fixture.bin");
const binDir = join(process.env.DATA_DIR, "bin");
const mockDir = join(process.env.DATA_DIR, "mock");
mkdirSync(binDir, { recursive: true });
mkdirSync(mockDir, { recursive: true });
writeFileSync(fixturePath, fixture);
const MODTIME = "2024-03-01T10:20:30Z";
const MOCK_MTIME = new Date(MODTIME).toUTCString();

// Mock rclone: `lsjson` reports the fixture's size/mtime (or fails on demand);
// `cat` streams the requested byte window of the fixture regardless of path;
// `lsl` defaults to "exists" so move-related checks behave.
const mockScript = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
case "$1" in
  lsjson)
    if [ -f "${mockDir}/stat_fail" ]; then echo boom >&2; exit 1; fi
    printf '[{"Name":"f.bin","Path":"x","Size":19,"ModTime":"${MODTIME}","IsDir":false}]'
    exit 0
    ;;
  cat)
    shift
    offset=0; count=9999999
    while [ $# -gt 0 ]; do
      case "$1" in
        --offset) offset="$2"; shift 2;;
        --count) count="$2"; shift 2;;
        *) shift;;
      esac
    done
    dd if="${fixturePath}" bs=1 skip="$offset" count="$count" 2>/dev/null
    exit 0
    ;;
  lsl|moveto)
    exit 0
    ;;
esac
exit 0
`;
writeFileSync(join(binDir, "rclone"), mockScript, { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;

let store: typeof import("../src/db").store;
let pages: Hono;
let actions: Hono;
let engineState: typeof import("../src/engine").engineState;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  engineState = (await import("../src/engine")).engineState;
  const scanRoot = join(process.env.DATA_DIR!, "scan");
  mkdirSync(scanRoot, { recursive: true });
  const { setSetting } = db;
  await setSetting("scan_root", scanRoot);
  const { logsapi } = await import("../src/routes/logsapi");
  const app = new Hono();
  app.route("/", logsapi);
  pages = app;
  actions = (await import("../src/routes/actions")).actions;
});

afterEach(() => {
  rmSync(join(mockDir, "stat_fail"), { force: true });
  engineState.running = false;
});

async function insertArchive(path = "protected.7z", status = "skipped"): Promise<number> {
  const created = new Date().toISOString();
  return store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES(?, ?, ?, 'password', ?, ?)",
    [path, fixture.length, status, created, created],
  );
}

async function bodyOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

test("full download: 200, Accept-Ranges, Content-Length and exact bytes", async () => {
  const id = await insertArchive();
  const res = await pages.request(`/download/archive-file/${id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  expect(res.headers.get("Content-Length")).toBe("19");
  expect(res.headers.get("Last-Modified")).toBe(MOCK_MTIME);
  expect(await bodyOf(res)).toEqual(fixture);
});

test("range download: 206 with Content-Range and exact byte window", async () => {
  const id = await insertArchive("range.bin");
  const res = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=2-5" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toBe("bytes 2-5/19");
  expect(res.headers.get("Content-Length")).toBe("4");
  expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  expect(await bodyOf(res)).toEqual(fixture.subarray(2, 6));
});

test("open-ended and suffix ranges; oversized range is clamped", async () => {
  const id = await insertArchive("ranges.bin");
  const open = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=10-" },
  });
  expect(open.status).toBe(206);
  expect(open.headers.get("Content-Range")).toBe("bytes 10-18/19");
  expect(await bodyOf(open)).toEqual(fixture.subarray(10));
  const suffix = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=-3" },
  });
  expect(suffix.status).toBe(206);
  expect(suffix.headers.get("Content-Range")).toBe("bytes 16-18/19");
  expect(await bodyOf(suffix)).toEqual(fixture.subarray(-3));
  const clamped = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=0-100" },
  });
  expect(clamped.status).toBe(206);
  expect(clamped.headers.get("Content-Range")).toBe("bytes 0-18/19");
});

test("unsatisfiable range: 416 with Content-Range bytes */size", async () => {
  const id = await insertArchive("unsat.bin");
  for (const Range of ["bytes=19-", "bytes=100-", "bytes=9-3"]) {
    const res = await pages.request(`/download/archive-file/${id}`, {
      headers: { Range },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */19");
  }
});

test("mismatched If-Range restarts with a full 200 instead of corrupting", async () => {
  const id = await insertArchive("ifrange.bin");
  const stale = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=2-5", "If-Range": "Mon, 01 Jan 1990 00:00:00 GMT" },
  });
  expect(stale.status).toBe(200);
  expect(await bodyOf(stale)).toEqual(fixture);
  const fresh = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=2-5", "If-Range": MOCK_MTIME },
  });
  expect(fresh.status).toBe(206);
  expect(fresh.headers.get("Content-Range")).toBe("bytes 2-5/19");
});

test("lsjson failure falls back to the stored size (still range-capable)", async () => {
  writeFileSync(join(mockDir, "stat_fail"), "");
  const id = await insertArchive("fallback.bin");
  const res = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=0-3" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("Content-Range")).toBe("bytes 0-3/19");
  expect(await bodyOf(res)).toEqual(fixture.subarray(0, 4));
});

test("range resume streams exactly what --offset/--count were given", async () => {
  // The mock slices the fixture at the requested window; the response body
  // must equal those exact bytes.
  const id = await insertArchive("window.bin");
  const res = await pages.request(`/download/archive-file/${id}`, {
    headers: { Range: "bytes=5-9" },
  });
  expect(res.status).toBe(206);
  expect(await bodyOf(res)).toEqual(fixture.subarray(5, 10));
});

test("active-download endpoint reports the in-flight count", async () => {
  const res = await pages.request("/download/archive-file/active");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.active).toBe("number");
  expect(body.active).toBeGreaterThanOrEqual(0);
});

test("delete is refused while that archive streams a download", async () => {
  const { registerDownload } = await import("../src/downloads");
  const id = await insertArchive("busy.bin");
  const unregister = registerDownload(id);
  try {
    const res = await actions.request(`/archives/${id}/delete`, { method: "POST" });
    expect(res.headers.get("HX-Trigger")).toContain("in progress");
    const row = await store.get1<{ status: string }>(
      "SELECT status FROM archives WHERE id = ?",
      [id],
    );
    expect(row?.status).toBe("skipped");
  } finally {
    unregister();
  }
});
