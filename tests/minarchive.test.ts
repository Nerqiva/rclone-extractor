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
  const base = mkdtempSync(join(tmpdir(), "rx-minsize-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const script = `#!/bin/sh
# strip leading hard-coded --config <path> pair
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  echo "./big.zip;5242880"
  echo "./edge.zip;1048576"
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
  // 1 MB limit: small.zip (100 KB) is ignored, big.zip (5 MB) and
  // edge.zip (exactly 1 MB) are queued.
  await setSetting("min_archive_size", String(MB));
  await setSetting("max_archive_size", "0");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;

  await runEngine();
});

test("archives below min_archive_size are ignored entirely", async () => {
  expect(await row(db!.store, "small.zip")).toBeNull();
  expect((await row(db!.store, "big.zip"))?.status).toBe("done");
});

test("an archive sized exactly at min_archive_size is kept", async () => {
  expect((await row(db!.store, "edge.zip"))?.status).toBe("done");
});

test("zero means no limit", async () => {
  await setSetting("min_archive_size", "0");
  await runEngine();
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
});

test("queued rows below the limit are not selected", async () => {
  await setSetting("min_archive_size", String(MB));
  await db!.store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('legacy-small.zip', ?, 'queued', 't', 't')",
    [100 * 1024],
  );
  await runEngine();
  // Legacy row stays queued until the limit is lowered; big rows run.
  expect((await row(db!.store, "legacy-small.zip"))?.status).toBe("queued");
  await db!.store.run("DELETE FROM archives WHERE path='legacy-small.zip'");
});

test("invalid stored value means no limit", async () => {
  await setSetting("min_archive_size", "not-a-number");
  await runEngine();
  expect((await row(db!.store, "small.zip"))?.status).toBe("done");
});
