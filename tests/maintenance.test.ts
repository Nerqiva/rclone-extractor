import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-maintenance-"));
delete process.env.DATABASE_URL;

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

test("clear runs is refused while a task is running", async () => {
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

test("clear runs wipes history, resets sequence and purges app temp dirs (dry-run)", async () => {
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

    expect(body).toContain("Cleared run history");
    expect(body).toContain("would purge 1 temp dir(s)");
    expect(body).toContain("Next run starts from #1");

    const runsLeft = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM runs");
    expect(Number(runsLeft?.c)).toBe(0);
    const logsLeft = await store.get1<{ c: number }>(
      "SELECT COUNT(*) AS c FROM log_lines WHERE scope='run'",
    );
    expect(Number(logsLeft?.c)).toBe(0);
    expect(await getSetting("last_run_id")).toBe("0");

    // Archives are not touched by clear runs.
    const arch = await store.get1<{ status: string }>(
      "SELECT status FROM archives WHERE path='keep-me.zip'",
    );
    expect(arch?.status).toBe("queued");

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
  expect(await ok.text()).toContain("Cleared all task data");

  const arch = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM archives");
  expect(Number(arch?.c)).toBe(0);
  const lines = await store.get1<{ c: number }>("SELECT COUNT(*) AS c FROM log_lines");
  expect(Number(lines?.c)).toBe(0);
});
