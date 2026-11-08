import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let setSetting: typeof import("../src/db").setSetting;

const MB = 1024 * 1024;

function row(store: typeof import("../src/db")["store"], path: string) {
  return store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path = ?",
    [path],
  );
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-maxsize-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const script = `#!/bin/sh
if [ "$1" = "lsf" ]; then
  echo "./big.zip;5000000"
  echo "./small.zip;100000"
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '40000 ./big.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
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
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  // 1 MB limit: small.zip (100 KB) passes, big.zip (5 MB) is ignored.
  await setSetting("max_archive_size", String(MB));

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;

  await runEngine();
});

test("archives above max_archive_size are ignored entirely", async () => {
  // big.zip must never be inserted into the queue/database.
  expect(await row(db!.store, "big.zip")).toBeNull();
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
});

test("raising the limit re-evaluates ignored archives on the next run", async () => {
  await setSetting("max_archive_size", String(10 * MB));
  await runEngine();
  expect((await row(db!.store, "big.zip"))?.status).toBe("done");
});

test("zero means no limit", async () => {
  await setSetting("max_archive_size", "0");
  // Both paths re-queue (done paths reappear in the listing) and are re-processed.
  await runEngine();
  expect((await row(db!.store, "big.zip"))?.status).toBe("done");
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
});

test("invalid stored values mean no limit", async () => {
  await setSetting("max_archive_size", "not-a-number");
  await runEngine();
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
});

test("queued rows above the limit are not selected", async () => {
  await setSetting("max_archive_size", String(MB));
  await db!.store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('legacy.zip', ?, 'queued', 't', 't')",
    [5 * MB],
  );
  await runEngine();
  // Legacy row stays queued until the limit is raised; under-limit rows run.
  expect((await row(db!.store, "legacy.zip"))?.status).toBe("queued");
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
  await db!.store.run("DELETE FROM archives WHERE path='legacy.zip'");
});
