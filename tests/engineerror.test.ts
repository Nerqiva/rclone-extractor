import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-engineerror-"));
delete process.env.DATABASE_URL;

let db: typeof import("../src/db");
let engine: typeof import("../src/engine");

beforeAll(async () => {
  db = await import("../src/db");
  await db.initDb();
  engine = await import("../src/engine");
});

test("an app error closes the run as outcome='error' with a code, logs and no interrupted flag", async () => {
  await db.setSetting("scan_root", "");
  await engine.runEngine();
  expect(engine.engineState.stage).toBe("error");
  const row = await db.store.get1<{
    id: number;
    outcome: string | null;
    error_kind: string | null;
    interrupted: number;
    finished_at: string | null;
  }>(
    "SELECT id, outcome, error_kind, interrupted, finished_at FROM runs ORDER BY id DESC LIMIT 1",
  );
  expect(row?.outcome).toBe("error");
  expect(row?.error_kind).toBe("no_scan_root");
  expect(Number(row?.interrupted ?? 0)).toBe(0);
  expect(row?.finished_at).toBeTruthy();
  const logs = await db.store.query<{ line: string }>(
    "SELECT line FROM log_lines WHERE scope='run' AND ref_id=? AND kind='errors'",
    [Number(row?.id ?? 0)],
  );
  expect(logs.some((l) => l.line.includes("code=no_scan_root"))).toBe(true);
});
