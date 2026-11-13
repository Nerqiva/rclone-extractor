import { test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "rx-heartbeat-"));
process.env.DATA_DIR = base;
delete process.env.DATABASE_URL;

const markDir = join(base, "markers");
mkdirSync(markDir, { recursive: true });

// Mock rclone: `lsl <...>/trash/stuck.zip` succeeds when the marker file
// exists, everything else fails loudly (or exits 0 for non-lsf calls).
const binDir = join(base, "bin");
mkdirSync(binDir, { recursive: true });
const scanRoot = join(base, "scan");
mkdirSync(scanRoot, { recursive: true });
const script = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsl" ]; then
  case "$*" in
    *stuck*)
      if [ -f "${markDir}/stuck" ]; then printf '5 t f.txt\\n'; exit 0; fi
      exit 1 ;;
    *) exit 1 ;;
  esac
fi
exit 0
`;
writeFileSync(join(binDir, "rclone"), script, { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;

let store: typeof import("../src/db").store;
let recoverStale: typeof import("../src/engine").recoverStale;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  await db.setSetting("scan_root", scanRoot);
  await db.setSetting("trash_subdir", "trash");
  recoverStale = (await import("../src/engine")).recoverStale;
});

beforeEach(async () => {
  await store.run("DELETE FROM archives");
  await store.run("DELETE FROM runs");
  await store.run("DELETE FROM log_lines");
  rmSync(`${markDir}/stuck`, { force: true });
});

const nowIso = () => new Date().toISOString();
const oldIso = () => new Date(Date.now() - 11 * 60 * 1000).toISOString();

async function insertExtracting(path: string, lastRunId: number | null) {
  await store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at, last_run_id) VALUES(?, 42, 'extracting', 't', 't', ?)",
    [path, lastRunId],
  );
}

async function insertRun(started: string, touched: string | null): Promise<number> {
  await store.run(
    "INSERT INTO runs(started_at, outcome, interrupted, last_touch_at) VALUES(?, '', 0, ?)",
    [started, touched],
  );
  return Number((await store.get1<{ id: number }>("SELECT id FROM runs ORDER BY id"))?.id);
}

test("settleTrash finalizes an archive whose trash copy exists", async () => {
  writeFileSync(`${markDir}/stuck`, "");
  await insertExtracting("stuck.zip", 0);
  const n = await recoverStale(true, "test", -1, true);
  expect(n).toBe(1);
  const row = await store.get1<{ status: string; error_kind: string | null }>(
    "SELECT status, error_kind FROM archives WHERE path='stuck.zip'",
  );
  expect(row?.status).toBe("done");
  expect(row?.error_kind).toBeNull();
});

test("settleTrash re-queues when the trash copy is gone", async () => {
  await insertExtracting("stuck.zip", 0);
  const n = await recoverStale(true, "test", -1, true);
  expect(n).toBe(1);
  const row = await store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='stuck.zip'",
  );
  expect(row?.status).toBe("queued");
});

test("a fresh peer's run and in-flight archive are left alone", async () => {
  const runId = await insertRun(nowIso(), nowIso());
  await insertExtracting("peer.zip", runId);
  const n = await recoverStale(true, "test", -1, true);
  expect(n).toBe(0);
  expect((await store.query("SELECT id FROM runs WHERE finished_at IS NULL")).length).toBe(1);
  const row = await store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='peer.zip'",
  );
  expect(row?.status).toBe("extracting");
});

test("a stale run is closed as killed and its archive re-queued", async () => {
  const runId = await insertRun(oldIso(), oldIso());
  await insertExtracting("stale.zip", runId);
  const n = await recoverStale(true, "test crash", -1);
  expect(n).toBe(1);
  const run = await store.get1<{ outcome: string; interrupted: number }>(
    "SELECT outcome, interrupted FROM runs WHERE id = ?",
    [runId],
  );
  expect(run?.outcome).toBe("killed");
  expect(run?.interrupted).toBe(1);
  const row = await store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='stale.zip'",
  );
  expect(row?.status).toBe("queued");
});

test("a legacy run without a heartbeat older than the threshold is reclaimed", async () => {
  const runId = await insertRun(oldIso(), null);
  await insertExtracting("legacy.zip", runId);
  const n = await recoverStale(true, "test crash", -1);
  expect(n).toBe(1);
  const row = await store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='legacy.zip'",
  );
  expect(row?.status).toBe("queued");
});

test("a legacy run that is young is not reclaimed", async () => {
  const runId = await insertRun(nowIso(), null);
  await insertExtracting("young.zip", runId);
  const n = await recoverStale(true, "test crash", -1);
  expect(n).toBe(0);
  expect((await store.get1<{ status: string }>("SELECT status FROM archives WHERE path='young.zip'"))?.status).toBe("extracting");
});

test("untagged archives are kept while a fresh peer is active", async () => {
  await insertRun(nowIso(), nowIso());
  await insertExtracting("untagged.zip", null);
  const n = await recoverStale(true, "test", -1);
  expect(n).toBe(0);
  expect((await store.get1<{ status: string }>("SELECT status FROM archives WHERE path='untagged.zip'"))?.status).toBe("extracting");
});

test("an untagged archive with no live peer is reclaimed", async () => {
  await insertExtracting("untagged.zip", null);
  const n = await recoverStale(true, "test", -1);
  expect(n).toBe(1);
  expect((await store.get1<{ status: string }>("SELECT status FROM archives WHERE path='untagged.zip'"))?.status).toBe("queued");
});
