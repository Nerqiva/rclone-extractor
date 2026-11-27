import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-directory, per-archive-family, per-run grouping rule:
 *
 * - The first archive of one archive family in one directory (this run)
 *   gets the usual pre-extraction inspection.
 * - The rest of that group whose names are related (incremental/decremental
 *   series or otherwise similar) are extracted first and inspected on the
 *   extracted tree instead (website dumps / torrent collections are skipped
 *   after extraction, mirroring the RcloneX fast path).
 * - If the first archive failed inspection (torrent/website/tiny/empty/
 *   unreadable/password) the whole group keeps pre-inspection.
 * - Unrelated names or a different family in the same directory are
 *   pre-inspected individually; grouping is not recursive.
 * - Group state is per run. Nothing is persisted.
 */

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let setSetting: typeof import("../src/db").setSetting;
let engineState: typeof import("../src/engine").engineState;
let rcloneLog: string;
let scanRoot: string;

function readLog(): string {
  return existsSync(rcloneLog) ? readFileSync(rcloneLog, "utf8") : "";
}
function resetLogs() {
  rmSync(rcloneLog, { force: true });
}
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
function postInspectLines(stem: string): string[] {
  const prefix = `lsf ${scanRoot}/.Rclone-Extractor-tmp/resume/`;
  return readLog().split("\n").filter((l) => l.includes(prefix) && l.includes(`/${stem} `));
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-group-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  rcloneLog = join(base, "rclone.log");

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  // Scan listing comes from RCLONE_STUB_SCAN (as printf-escaped lines).
  // Post-extraction lsf of the temp tree prints a website/torrent/empty
  // tree when the extracted stem is listed in one of the three CSV env
  // vars; otherwise a clean single large file.
  const rcloneScript = `#!/bin/sh
echo "rclone $*" >> "${rcloneLog}"
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$2" in
    *Rclone-Extractor-tmp*)
      name="\${2##*/}"
      case ",$RCLONE_STUB_WEB_STEMS," in
        *",$name,"*) printf './index.html;100\\n./styles.css;100\\n./app.js;100\\n'; exit 0 ;;
      esac
      case ",$RCLONE_STUB_TORRENT_STEMS," in
        *",$name,"*) printf './a.torrent;2048\\n./b.torrent;2048\\n./c.torrent;2048\\n./big.bin;50000\\n'; exit 0 ;;
      esac
      case ",$RCLONE_STUB_EMPTY_STEMS," in
        *",$name,"*) exit 0 ;;
      esac
      printf './big.bin;300000\\n'
      exit 0
      ;;
    *) printf '%s' "$RCLONE_STUB_SCAN"; exit 0 ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  case "$3" in
    *site*) printf '10 ./index.html\\n10 ./styles.css\\n' ;;
    *)      printf '300000 ./big.bin\\n' ;;
  esac
  exit 0
fi
exit 0
`;
  writeFileSync(join(binDir, "rclone"), rcloneScript, { mode: 0o755 });
  chmodSync(join(binDir, "rclone"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  engineState = eng.engineState;
});

beforeEach(async () => {
  delete process.env.RCLONE_STUB_SCAN;
  delete process.env.RCLONE_STUB_WEB_STEMS;
  delete process.env.RCLONE_STUB_TORRENT_STEMS;
  delete process.env.RCLONE_STUB_EMPTY_STEMS;
  await db!.store.run("DELETE FROM archives");
  await db!.store.run("DELETE FROM runs");
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  engineState.running = false;
});

afterEach(() => {
  engineState.running = false;
});

test("first archive is pre-inspected; similar series are inspected post-extraction", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/pack1.zip;100000\n./set/pack2.zip;100000\n./set/pack3.zip;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  const log = readLog();
  // Only the series anchor was pre-inspected...
  expect(countOccurrences(log, "archive list")).toBe(1);
  expect(log).toContain(`archive list ${scanRoot}`);
  expect(log).toContain("set/pack1.zip");
  expect(log).not.toContain("pack2.zip --files-only");
  expect(log).not.toContain("pack3.zip --files-only");
  // ...and the two deferred archives were listed on their extracted tree.
  expect(postInspectLines("pack2")).toHaveLength(1);
  expect(postInspectLines("pack3")).toHaveLength(1);
}, 10_000);

test("first archive classified as website closes the gate for the whole group", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/site1.zip;100000\n./set/site2.zip;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  expect(rows.map((r) => r.error_kind)).toEqual(["website", "website"]);
  const log = readLog();
  // Both were pre-inspected; nothing was extracted first.
  expect(countOccurrences(log, "archive list")).toBe(2);
  expect(log).toContain("site1.zip --files-only");
  expect(log).toContain("site2.zip --files-only");
  expect(log).not.toMatch(/lsf [^\n]*Rclone-Extractor-tmp\/run_\d/);
}, 10_000);

test("unrelated filenames in one directory are pre-inspected individually", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/pack1.zip;100000\n./set/zzz.zip;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  const log = readLog();
  expect(countOccurrences(log, "archive list")).toBe(2);
  expect(log).toContain("pack1.zip --files-only");
  expect(log).toContain("zzz.zip --files-only");
}, 10_000);

test("grouping is per archive family inside one directory", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/pack1.zip;100000\n./set/pack2.tar.gz;100000\n./set/pack3.zip;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  const log = readLog();
  // pack1.zip is first of the zip family; pack2.tar.gz is first of its own
  // family; pack3.zip is extract-first.
  expect(countOccurrences(log, "archive list")).toBe(2);
  expect(log).toContain("pack1.zip --files-only");
  expect(log).toContain("pack2.tar.gz --files-only");
  expect(log).not.toContain("pack3.zip --files-only");
  expect(postInspectLines("pack3")).toHaveLength(1);
}, 10_000);

test("alias extensions of one family (.tgz / .tar.gz) group together", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/pack1.tgz;100000\n./set/pack2.tar.gz;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  const log = readLog();
  expect(countOccurrences(log, "archive list")).toBe(1);
  expect(log).toContain("pack1.tgz --files-only");
  expect(log).not.toContain("pack2.tar.gz --files-only");
  expect(postInspectLines("pack2")).toHaveLength(1);
}, 10_000);

test("post-extraction inspection skips a website dump among the rest of the series", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/dump1.zip;100000\n./set/dump2.zip;100000\n";
  process.env.RCLONE_STUB_WEB_STEMS = "dump2";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives ORDER BY path",
  );
  expect(rows.map((r) => [r.path, r.status, r.error_kind])).toEqual([
    ["set/dump1.zip", "done", null],
    ["set/dump2.zip", "skipped", "website"],
  ]);
  const log = readLog();
  // The skipped archive stays in place. It is never promoted or trashed.
  expect(log).not.toMatch(/moveto[^\n]*dump2\.zip/);
  expect(log).toContain("purge");
}, 10_000);

test("post-extraction inspection skips a torrent collection among the rest of the series", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/tor1.zip;100000\n./set/tor2.zip;100000\n";
  process.env.RCLONE_STUB_TORRENT_STEMS = "tor2";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives ORDER BY path",
  );
  expect(rows.map((r) => [r.path, r.status, r.error_kind])).toEqual([
    ["set/tor1.zip", "done", null],
    ["set/tor2.zip", "skipped", "torrent"],
  ]);
}, 10_000);

test("an empty extracted tree is promoted as usual", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/emp1.zip;100000\n./set/emp2.zip;100000\n";
  process.env.RCLONE_STUB_EMPTY_STEMS = "emp2";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
}, 10_000);

test("groups are directory-level and not recursive", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./deep/pack1.zip;100000\n./deep/sub/pack2.zip;100000\n";
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  const log = readLog();
  // pack2 lives in a different directory: it anchors its own group and is
  // pre-inspected there.
  expect(countOccurrences(log, "archive list")).toBe(2);
}, 10_000);

test("group state is per run and does not leak across runs", async () => {
  process.env.RCLONE_STUB_SCAN =
    "./set/pack1.zip;100000\n./set/pack2.zip;100000\n";
  resetLogs();
  await runEngine();
  expect(countOccurrences(readLog(), "archive list")).toBe(1);
  // Done archives are re-queued on the next run (existing behavior); the
  // grouping rule must be recomputed, so the first archive of the series is
  // pre-inspected again instead of "already handled" being remembered.
  resetLogs();
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  await runEngine();
  expect(countOccurrences(readLog(), "archive list")).toBe(1);
}, 15_000);

