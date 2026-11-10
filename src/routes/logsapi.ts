import { Hono } from "hono";
import { store, getSetting } from "../db";
import { tailRendered, readAll, LOG_TAIL_LIMIT } from "../log";
import { engineState } from "../engine";
import { readErrorRows, renderErrorCards } from "../errorrows";

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
