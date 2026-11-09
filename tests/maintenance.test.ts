import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-maintenance-"));
delete process.env.DATABASE_URL;

// This suite shells out to rclone (maintenance routes purge app temp dirs
// via `rclone lsf --dirs-only`). Install a mock so the test does not depend
// on an ambient rclone or on PATH polluted by other test files.
const mockBase = process.env.DATA_DIR;
const binDir = join(mockBase, "bin");
mkdirSync(binDir, { recursive: true });
const mockScript = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  echo "123/"
  exit 0
fi
if [ "$1" = "purge" ]; then
  exit 0
fi
exit 0
`;
writeFileSync(join(binDir, "rclone"), mockScript, { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;

let store: typeof import("../src/db").store;
let engineState: typeof import("../src/engine").engineState;
let getSetting: typeof import("../src/db").getSetting;
let setSetting: typeof import("../src/db").setSetting;
let app: Hono;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  getSetting = db.getSetting;
  setSetting = db.setSetting;
  await db.initDb();

  engineState = (await import("../src/engine")).engineState;

  const actions = (await import("../src/routes/actions")).actions;
  app = new Hono();
  app.route("/", actions);
});

afterEach(() => {
  engineState.running = false;
});

async function insertRun() {
  return store.insertReturningId("INSERT INTO runs(started_at, total) VALUES('t', 0)", []);
}

test("clear history is refused while a task is running", async () => {
  engineState.running = true;
  const id = await insertRun();
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('run', ?, 'main', 0, 't', 'INFO', 'busy')",
    [id],
  );
  const res = await app.request("/maintenance/runs", { method: "POST" });
  const body = await res.text();
  expect(body).toContain("stop it first");
  const count = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM runs WHERE id = ?", [
    id,
  ]);
  expect(Number(count?.c)).toBe(1);
  engineState.running = false;
  // cleanup
  await store.run("DELETE FROM log_lines WHERE scope='run' AND ref_id = ?", [id]);
  await store.run("DELETE FROM runs WHERE id = ?", [id]);
});

test("clear history wipes history, queue and caches, resets sequence and purges app temp dirs (dry-run)", async () => {
  const savedTmpDir = (await getSetting("tmp_dir")) ?? "";
  const tmpRoot = mkdtempSync(join(tmpdir(), "rx-maint-tmp-"));
  mkdirSync(join(tmpRoot, "123")); // app-owned numeric run dir
  mkdirSync(join(tmpRoot, "keep-me")); // not app-owned: must survive
  await setSetting("tmp_dir", tmpRoot);
  await setSetting("dry_run", "1");
  await setSetting("last_run_id", "42");

  const id = await insertRun();
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('run', ?, 'main', 0, 't', 'INFO', 'busy')",
    [id],
  );
  await store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES('keep-me.zip', 5, 'queued', 't', 't')",
  );

  const res = await app.request("/maintenance/runs", { method: "POST" });
  try {
    const body = await res.text();

    expect(body).toContain("Cleared history");
    expect(body).toContain("would purge 1 temp dir(s)");
    expect(body).toContain("Next run starts from #1");

    const runsLeft = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM runs");
    expect(Number(runsLeft?.c)).toBe(0);
    const logsLeft = await store.get1<{ c: number }>(
      "SELECT COUNT(*) AS c FROM log_lines WHERE scope='run'",
    );
    expect(Number(logsLeft?.c)).toBe(0);
    expect(await getSetting("last_run_id")).toBe("0");

    // Clear history also clears the archive cache and the queue.
    const arch = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM archives");
    expect(Number(arch?.c)).toBe(0);

    // Sequence reset: next run id is 1.
    const newId = await store.insertReturningId(
      "INSERT INTO runs(started_at, total) VALUES('t', 0)",
      [],
    );
    expect(newId).toBe(1);
    await store.run("DELETE FROM runs WHERE id = ?", [newId]);
  } finally {
    await store.run("DELETE FROM archives WHERE path='keep-me.zip'");
    await setSetting("dry_run", "0");
    await setSetting("tmp_dir", savedTmpDir);
  }
});

test("clear everything wipes archives too", async () => {
  engineState.running = true;
  const res = await app.request("/maintenance/all", { method: "POST" });
  expect(await res.text()).toContain("stop it first");
  engineState.running = false;

  await store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES('wipe-me.zip', 5, 'queued', 't', 't')",
  );
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('archive', 1, 'extract', 0, 't', NULL, 'x')",
  );
  const ok = await app.request("/maintenance/all", { method: "POST" });
  expect(await ok.text()).toContain("Cleared everything");

  const arch = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM archives");
  expect(Number(arch?.c)).toBe(0);
  const lines = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM log_lines");
  expect(Number(lines?.c)).toBe(0);
});

test("clear queues is allowed while running and keeps run count, history and caches", async () => {
  engineState.running = true;
  const id = await insertRun();
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('run', ?, 'main', 0, 't', 'INFO', 'busy')",
    [id],
  );
  for (const [path, status] of [
    ["q1.zip", "queued"],
    ["q2.zip", "queued"],
    ["done1.zip", "done"],
    ["failed1.zip", "failed"],
  ] as const) {
    await store.run(
      "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES(?, 5, ?, 't', 't')",
      [path, status],
    );
  }
  const q1 = await store.get1<{ id: number }>("SELECT id FROM archives WHERE path='q1.zip'");
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('archive', ?, 'extract', 0, 't', NULL, 'x')",
    [Number(q1?.id ?? 0)],
  );

  const res = await app.request("/maintenance/queues", { method: "POST" });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Cleared queue");
  const remaining = await store.query<{ path: string }>(
    "SELECT path FROM archives ORDER BY path",
  );
  expect(remaining.map((r) => r.path)).toEqual(["done1.zip", "failed1.zip"]);
  const archLines = await store.get1<{ c: number }>(
    "SELECT COUNT(*) AS c FROM log_lines WHERE scope='archive'",
  );
  expect(Number(archLines?.c)).toBe(0);
  const runsLeft = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM runs");
  expect(Number(runsLeft?.c)).toBe(1);
  const runLines = await store.get1<{ c: number }>(
    "SELECT COUNT(*) AS c FROM log_lines WHERE scope='run'",
  );
  expect(Number(runLines?.c)).toBe(1);
  engineState.running = false;
  // cleanup
  await store.run("DELETE FROM log_lines WHERE scope='run'");
  await store.run("DELETE FROM runs WHERE id = ?", [id]);
  await store.run("DELETE FROM archives");
  await store.run("DELETE FROM logs");
});

test("clear logs wipes logs and errors but keeps runs and archives", async () => {
  engineState.running = true;
  const blocked = await app.request("/maintenance/logs", { method: "POST" });
  expect(await blocked.text()).toContain("stop it first");
  engineState.running = false;

  const id = await insertRun();
  await store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES('err.zip', 5, 'failed', 'extract', 't', 't')",
  );
  await store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES('run', ?, 'errors', 0, 't', 'ERROR', 'x')",
    [id],
  );
  const res = await app.request("/maintenance/logs", { method: "POST" });
  expect(await res.text()).toContain("Cleared logs and errors");
  const lines = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM log_lines");
  expect(Number(lines?.c)).toBe(0);
  const arch = await store.get1<{ error_kind: string | null }>(
    "SELECT error_kind FROM archives WHERE path='err.zip'",
  );
  expect(arch?.error_kind).toBeNull();
  const runsLeft = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM runs");
  expect(Number(runsLeft?.c)).toBe(1);
  // cleanup
  await store.run("DELETE FROM runs WHERE id = ?", [id]);
  await store.run("DELETE FROM archives WHERE path='err.zip'");
  await store.run("DELETE FROM logs");
});

test("tmp-purge is refused while a task is running", async () => {
  engineState.running = true;
  const res = await app.request("/maintenance/tmp-purge", { method: "POST" });
  expect(await res.text()).toContain("stop it first");
  engineState.running = false;
});
