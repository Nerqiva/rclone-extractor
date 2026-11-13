import { test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let engine: typeof import("../src/engine");
let setSetting: typeof import("../src/db").setSetting;

async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-skip-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  // RCLONE_STUB_BLOCK selects which operation hangs (until the engine kills it):
  //   lsf     - the recursive listing blocks forever
  //   list    - the archive inspection blocks forever
  //   extract - the extraction blocks forever
  // Everything else exits 0 with a clean, empty output.
  const script = `#!/bin/sh
# strip leading hard-coded --config <path> pair
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$*" in
    *--recursive*)
      if [ "$RCLONE_STUB_BLOCK" = "lsf" ]; then exec sleep 3600; fi
      echo "./victim.zip;100000"; exit 0 ;;
    *) exit 0 ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  if [ "$RCLONE_STUB_BLOCK" = "list" ]; then exec sleep 3600; fi
  printf '40000 ./big.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  if [ "$RCLONE_STUB_BLOCK" = "extract" ]; then exec sleep 3600; fi
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
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");

  engine = await import("../src/engine");
});

beforeEach(async () => {
  await db!.store.run("DELETE FROM archives");
  await db!.store.run("DELETE FROM runs");
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  engine.engineState.running = false;
  engine.engineState.stage = "idle";
  engine.engineState.activity = "";
  engine.engineState.stopRequested = false;
  engine.engineState.forceStop = false;
  engine.engineState.skipListing = false;
  engine.engineState.skipInspection = false;
  engine.engineState.skipArchive = false;
  engine.engineState.done = 0;
  engine.engineState.failed = 0;
  engine.engineState.skipped = 0;
  engine.engineState.total = 0;
  process.env.RCLONE_STUB_BLOCK = "";
});

test("skip listing stops the scan early and continues with the stored queue", async () => {
  await db!.store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('seeded.zip', 100000, 'queued', 't', 't')",
  );
  process.env.RCLONE_STUB_BLOCK = "lsf";
  const done = engine.runEngine();
  const sawListing = await waitFor(() => engine.engineState.stage === "listing");
  expect(sawListing).toBe(true);
  expect(engine.requestSkipListing()).toBe(true);
  await done;
  expect(engine.engineState.stage).toBe("finished");
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='seeded.zip'",
  );
  expect(row?.status).toBe("done");
  // The rescan never queued the stub's victim.zip.
  expect(
    await db!.store.get1("SELECT id FROM archives WHERE path='victim.zip'"),
  ).toBeNull();
  expect(engine.engineState.skipListing).toBe(false);
});

test("skip inspection bypasses the inspection and extracts the archive", async () => {
  process.env.RCLONE_STUB_BLOCK = "list";
  const done = engine.runEngine();
  const sawInspect = await waitFor(
    () => engine.engineState.activity === "Inspecting archive",
  );
  expect(sawInspect).toBe(true);
  expect(engine.requestSkipInspection()).toBe(true);
  await done;
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='victim.zip'",
  );
  expect(row?.status).toBe("done");
  expect(engine.engineState.skipInspection).toBe(false);
  expect(engine.engineState.skipped).toBe(0);
});

test("skip archive re-queues the current archive and finishes the run", async () => {
  process.env.RCLONE_STUB_BLOCK = "extract";
  const done = engine.runEngine();
  const sawExtract = await waitFor(
    () => engine.engineState.activity === "Extracting",
  );
  expect(sawExtract).toBe(true);
  expect(engine.requestSkipArchive()).toBe(true);
  await done;
  const row = await db!.store.get1<{ status: string; error_kind: string | null }>(
    "SELECT status, error_kind FROM archives WHERE path='victim.zip'",
  );
  expect(row?.status).toBe("queued");
  expect(row?.error_kind).toBeNull();
  expect(engine.engineState.skipped).toBe(1);
  expect(engine.engineState.skipArchive).toBe(false);
});

test("skip requests are rejected outside their stage", async () => {
  engine.engineState.running = false;
  expect(engine.requestSkipListing()).toBe(false);
  expect(engine.requestSkipInspection()).toBe(false);
  expect(engine.requestSkipArchive()).toBe(false);
  engine.engineState.running = true;
  engine.engineState.stage = "queueing";
  engine.engineState.activity = "Building queue";
  expect(engine.requestSkipListing()).toBe(false);
  expect(engine.requestSkipArchive()).toBe(false);
  expect(engine.requestSkipInspection()).toBe(false);
  engine.engineState.running = false;
  engine.engineState.stage = "idle";
  engine.engineState.activity = "";
});
