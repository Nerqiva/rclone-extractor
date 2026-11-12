import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let recoverStale: typeof import("../src/engine").recoverStale;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-interrupt-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  db = await import("../src/db");
  await db.initDb();
  const eng = await import("../src/engine");
  recoverStale = eng.recoverStale;
});

async function seedUnfinishedRun(): Promise<number> {
  const id = await db!.store.insertReturningId(
    "INSERT INTO runs(started_at, finished_at) VALUES(?, NULL)",
    [new Date().toISOString()],
  );
  return id;
}

test("a crash-recovered run gets interrupted=1, outcome='killed' and the boot reason", async () => {
  const id = await seedUnfinishedRun();
  await recoverStale(true);
  const row = await db!.store.get1<{
    interrupted: number;
    interrupted_reason: string | null;
    finished_at: string | null;
    outcome: string | null;
  }>("SELECT interrupted, interrupted_reason, finished_at, outcome FROM runs WHERE id = ?", [
    id,
  ]);
  expect(Number(row?.interrupted)).toBe(1);
  expect(row?.outcome).toBe("killed");
  expect(row?.interrupted_reason).toBe(
    "previous process exited mid-run (crash or kill)",
  );
  expect(row?.finished_at).toBeTruthy();
});

test("a signal-settled run gets interrupted=1, outcome='killed' and the signal reason", async () => {
  const id = await seedUnfinishedRun();
  await recoverStale(true, "received SIGTERM (deploy or restart)");
  const row = await db!.store.get1<{
    interrupted: number;
    interrupted_reason: string | null;
    outcome: string | null;
  }>("SELECT interrupted, interrupted_reason, outcome FROM runs WHERE id = ?", [id]);
  expect(Number(row?.interrupted)).toBe(1);
  expect(row?.outcome).toBe("killed");
  expect(row?.interrupted_reason).toBe("received SIGTERM (deploy or restart)");
});

test("a normally-finished run is not touched by recovery", async () => {
  const id = await db!.store.insertReturningId(
    "INSERT INTO runs(started_at, finished_at) VALUES(?, ?)",
    [new Date().toISOString(), new Date().toISOString()],
  );
  await recoverStale(true, "must not apply");
  const row = await db!.store.get1<{
    interrupted: number;
    interrupted_reason: string | null;
  }>("SELECT interrupted, interrupted_reason FROM runs WHERE id = ?", [id]);
  expect(Number(row?.interrupted)).toBe(0);
  expect(row?.interrupted_reason).toBeNull();
});
