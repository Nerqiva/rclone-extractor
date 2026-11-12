import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let setSetting: typeof import("../src/db").setSetting;
let lsfMarker: string;

function marker() {
  return existsSync(lsfMarker);
}

function resetMarker() {
  rmSync(lsfMarker, { force: true });
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-cache-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  lsfMarker = join(base, "lsf-called");

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  // lsf --recursive appends to the marker file; plain dirs-only lsf (used by
  // the temp purge) does not. The marker records whether a fresh scan ran.
  const script = `#!/bin/sh
# strip leading hard-coded --config <path> pair
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$*" in
    *--recursive*) echo called >> "${lsfMarker}"; echo "./rescan.zip;100000"; exit 0 ;;
    *) exit 0 ;;
  esac
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
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");

  // Cached results from a "previous completed scan of this root". The
  // fingerprint covers scan_root, size limits, queue size, dry-run, trash and
  // auto_skip_known — the same shape the engine computes.
  await db!.store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('cached.zip', 100000, 'queued', 't', 't')",
  );
  await setSetting(
    "scan_cache_key",
    [scanRoot, "0", "0", "500", "0", "trash", "1"].join("|"),
  );
  await setSetting("scan_cache_state", "complete");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
});

test("a valid cache skips the remote listing entirely", async () => {
  resetMarker();
  await runEngine({ reuseScan: true });
  expect(marker()).toBe(false);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='cached.zip'",
  );
  expect(row?.status).toBe("done");
  // The reuse path does not rewrite cache markers; they remain valid.
  expect((await db!.getSetting("scan_cache_state", ""))).toBe("complete");
  // The freshly-listed archive is NOT picked up in reuse mode.
  expect(
    await db!.store.get1("SELECT id FROM archives WHERE path='rescan.zip'"),
  ).toBeNull();
});

test("an incomplete cache falls back to a fresh scan", async () => {
  resetMarker();
  await setSetting("scan_cache_state", "incomplete");
  await runEngine({ reuseScan: true });
  expect(marker()).toBe(true);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='rescan.zip'",
  );
  expect(row?.status).toBe("done");
  // A natural listing refreshes the cache marker.
  expect((await db!.getSetting("scan_cache_state", ""))).toBe("complete");
});

test("a cache fingerprinted for different settings falls back to a fresh scan", async () => {
  resetMarker();
  await setSetting("scan_cache_state", "complete");
  await setSetting("scan_cache_key", "s3:elsewhere|0|0|500|0|trash|1");
  await runEngine({ reuseScan: true });
  expect(marker()).toBe(true);
});

test("reuse without the option does nothing", async () => {
  resetMarker();
  await setSetting("scan_cache_state", "complete");
  await setSetting("scan_cache_key", "anything|0|0|500|0|trash|1");
  await runEngine();
  expect(marker()).toBe(true);
});
