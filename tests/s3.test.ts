import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let engineState: typeof import("../src/engine").engineState;
let getSetting: typeof import("../src/db").getSetting;
let setSetting: typeof import("../src/db").setSetting;
let readAll: typeof import("../src/log").readAll;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-s3-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const script = `#!/bin/sh
if [ "$1" = "lsf" ]; then
  echo "./a/b.zip;1000"
  echo "./a/c.zip;1000"
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  case "$3" in
    *b.zip*) exit 0 ;;
    *c.zip*) echo "password required" 1>&2; exit 1 ;;
  esac
  exit 0
fi
exit 0
`;
  const binPath = join(binDir, "rclone");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  getSetting = db.getSetting;
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  engineState = eng.engineState;
  readAll = (await import("../src/log")).readAll;

  await runEngine();
});

test("engine processes archives", async () => {
  const rows = await db!.store.query<{
    path: string;
    status: string;
    error_kind: string | null;
  }>("SELECT path, status, error_kind FROM archives ORDER BY path");
  const done = rows.filter((r) => r.status === "done");
  const skipped = rows.filter((r) => r.status === "skipped");
  expect(done.length).toBe(1);
  expect(done[0].path).toBe("a/b.zip");
  expect(skipped.length).toBe(1);
  expect(skipped[0].path).toBe("a/c.zip");
  expect(skipped[0].error_kind).toBe("password");
  expect(engineState.done).toBe(1);
  expect(engineState.skipped).toBe(1);
  expect(await getSetting("scan_root")).toBeTruthy();
});

test("run log and error log include the active rclone command", async () => {
  const main = await readAll({
    scope: "run",
    refId: engineState.runId,
    kind: "main",
  });
  expect(main.some((line) => line.includes("$ rclone lsf"))).toBe(true);

  const errors = await readAll({
    scope: "run",
    refId: engineState.runId,
    kind: "errors",
  });
  const commandLine = errors.find((line) =>
    line.includes("$ rclone archive extract"),
  );
  expect(commandLine).toBeDefined();
  expect(commandLine).toContain("c.zip");
});

test("per-archive log records the command that ran", async () => {
  const row = await db!.store.get1<{ id: number }>(
    "SELECT id FROM archives WHERE path='a/c.zip'",
  );
  expect(row).toBeDefined();
  const lines = await readAll({
    scope: "archive",
    refId: Number(row!.id),
    kind: "extract",
  });
  expect(lines.some((line) => line.includes("$ rclone archive extract"))).toBe(
    true,
  );
});

test("done paths are re-queued on a later non-dry run", async () => {
  await setSetting("dry_run", "0");
  await runEngine();
  expect(engineState.total).toBe(1);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='a/b.zip'",
  );
  expect(row?.status).toBe("done");
});

test("dry-run does not re-queue done paths", async () => {
  await setSetting("dry_run", "1");
  await runEngine();
  expect(engineState.total).toBe(0);
  await setSetting("dry_run", "0");
});

test("resume recovers stale extracting rows", async () => {
  await db!.store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES('stale.zip', 5, 'extracting', 't', 't')",
  );
  const eng = await import("../src/engine");
  const recovered = await eng.recoverStale();
  expect(recovered).toBeGreaterThanOrEqual(1);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='stale.zip'",
  );
  expect(row?.status).toBe("queued");
});
