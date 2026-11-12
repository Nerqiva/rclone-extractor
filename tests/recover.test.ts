import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-recover-"));
delete process.env.DATABASE_URL;

let store: typeof import("../src/db").store;
let recoverStale: typeof import("../src/engine").recoverStale;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  recoverStale = (await import("../src/engine")).recoverStale;
});

async function insertExtracting(path: string) {
  await store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES(?, 5, 'extracting', 't', 't')",
    [path],
  );
}

test("resume on re-queues stale extracting rows", async () => {
  await insertExtracting("resume-on.zip");
  const n = await recoverStale(true);
  expect(n).toBeGreaterThanOrEqual(1);
  const row = await store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='resume-on.zip'",
  );
  expect(row?.status).toBe("queued");
});

test("resume off marks stale extracting rows failed/killed", async () => {
  await insertExtracting("resume-off.zip");
  const n = await recoverStale(false);
  expect(n).toBeGreaterThanOrEqual(1);
  const row = await store.get1<{ status: string; error_kind: string }>(
    "SELECT status, error_kind FROM archives WHERE path='resume-off.zip'",
  );
  expect(row?.status).toBe("failed");
  expect(row?.error_kind).toBe("killed");
});
