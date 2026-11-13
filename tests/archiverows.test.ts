import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-archiverows-"));
delete process.env.DATABASE_URL;

let store: typeof import("../src/db").store;
let app: Hono;
let seeded: { runId: number; a: number; b: number };

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  // The migration must have added the column (and be idempotent on re-run).
  await db.initDb();
  const row = await store.get1<{ last_run_id: number | null }>(
    "SELECT last_run_id FROM archives LIMIT 1",
  );
  expect(row === null || typeof row.last_run_id !== "undefined").toBe(true);

  const logsapi = (await import("../src/routes/logsapi")).logsapi;
  app = new Hono();
  app.route("/", logsapi);

  seeded = await seedRunWithArchives();
});

async function seedRunWithArchives(): Promise<{ runId: number; a: number; b: number }> {
  const created = new Date().toISOString();
  const runId = await store.insertReturningId(
    "INSERT INTO runs(started_at, finished_at, total, done, outcome) VALUES(?, ?, 2, 2, 'finished')",
    [created, created],
  );
  const a = await store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at, last_run_id) VALUES('incoming/alpha.zip', 100, 'done', NULL, ?, ?, ?)",
    [created, created, runId],
  );
  const b = await store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at, last_run_id) VALUES('incoming/beta.rar', 200, 'skipped', 'website', ?, ?, ?)",
    [created, created, runId],
  );
  // Untagged archive (another run / never processed).
  await store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES('incoming/unrelated.zip', 300, 'done', NULL, ?, ?)",
    [created, created],
  );
  const { insertLogLines } = await import("../src/log");
  await insertLogLines({ scope: "run", refId: runId, kind: "main" }, ["run start", "run end"]);
  await insertLogLines({ scope: "run", refId: runId, kind: "errors" }, ["boom"]);
  await insertLogLines({ scope: "archive", refId: a, kind: "extract" }, ["alpha raw line 1", "alpha raw line 2"]);
  return { runId, a, b };
}

test("archives fragment lists only archives tagged with the run", async () => {
  const { runId } = seeded;
  const res = await app.request(`/logs/archives-fragment?run=${runId}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("alpha.zip");
  expect(html).toContain("beta.rar");
  expect(html).not.toContain("unrelated.zip");
  expect(html).toContain("data-log-toggle");
  expect(html).toContain("ar-log-");
});

test("archives fragment renders pills per status", async () => {
  const { runId } = seeded;
  const res = await app.request(`/logs/archives-fragment?run=${runId}`);
  const html = await res.text();
  expect(html).toContain(">done<");
  expect(html).toContain(">website<");
});

test("archives-fragment rejects a bad run id", async () => {
  expect((await app.request("/logs/archives-fragment?run=0")).status).toBe(404);
  expect((await app.request("/logs/archives-fragment?run=nope")).status).toBe(404);
});

test("download all exports run log, errors log and every archive log", async () => {
  const { runId } = seeded;
  const res = await app.request(`/download/run/${runId}/all`);
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toContain(`run-${runId}-all.log`);
  const text = await res.text();
  expect(text).toContain(`RUN #${runId} — run log`);
  expect(text).toContain("run start");
  expect(text).toContain(`RUN #${runId} — errors`);
  expect(text).toContain("boom");
  expect(text).toContain("ARCHIVE");
  expect(text).toContain("incoming/alpha.zip");
  expect(text).toContain("alpha raw line 2");
  expect(text).toContain("incoming/beta.rar");
  expect(text).toContain("(no log lines recorded)");
  expect(text).not.toContain("unrelated.zip");
});

test("download all is 404 for runs with no output", async () => {
  const emptyRun = await store.insertReturningId(
    "INSERT INTO runs(started_at, total) VALUES('t', 0)",
    [],
  );
  expect((await app.request(`/download/run/${emptyRun}/all`)).status).toBe(404);
});

test("archive log fragment respects the inline limit and links to the full log", async () => {
  const { a } = seeded;
  const res = await app.request(`/logs/archive/${a}/fragment?limit=300`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("alpha raw line 1");
  expect(html).toContain("download the full log");
  expect(html).toContain(`/download/archive/${a}`);
});

test("renderArchiveLogRows renders the empty state", async () => {
  const { renderArchiveLogRows } = await import("../src/archiverows");
  expect(renderArchiveLogRows([])).toContain("No archives processed yet.");
});
