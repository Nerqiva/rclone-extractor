import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Post-extraction inspection for rclonex-handled archives: after extraction,
 * the engine lists the extracted tree and skips website dumps and torrent
 * collections (purging the extracted data, keeping the archive in place).
 * Everything else continues as a normal extraction.
 */

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let setSetting: typeof import("../src/db").setSetting;
let engineState: typeof import("../src/engine").engineState;
let rcloneLog: string;
let rclonexLog: string;

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function resetLogs() {
  rmSync(rcloneLog, { force: true });
  rmSync(rclonexLog, { force: true });
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-postinspect-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  rcloneLog = join(base, "rclone.log");
  rclonexLog = join(base, "rclonex.log");

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const rcloneScript = `#!/bin/sh
echo "rclone $*" >> "${rcloneLog}"
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$2" in
    *Rclone-Extractor-tmp*)
      case "\${2##*/}" in
        site)   printf './index.html;100\\n./styles.css;100\\n./app.js;100\\n' ;;
        tor)    printf './a.torrent;2048\\n./b.torrent;2048\\n./c.torrent;2048\\n./big.bin;50000\\n' ;;
        normal) printf './big.bin;300000\\n' ;;
        *)      printf './big.bin;300000\\n' ;;
      esac
      exit 0 ;;
    *) case "$*" in
        *--recursive*) echo "./site.rar;100000" ; echo "./normal.rar;100000" ; echo "./tor.rar;100000" ; exit 0 ;;
        *) exit 0 ;;
      esac ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '40000 ./big.bin\\n'
  exit 0
fi
exit 0
`;
  const rclonexScript = `#!/bin/sh
echo "rclonex $*" >> "${rclonexLog}"
if [ "$1" = "--config" ]; then shift 2; fi
exit 0
`;
  writeFileSync(join(binDir, "rclone"), rcloneScript, { mode: 0o755 });
  writeFileSync(join(binDir, "rclonex"), rclonexScript, { mode: 0o755 });
  chmodSync(join(binDir, "rclone"), 0o755);
  chmodSync(join(binDir, "rclonex"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.RCLONEX_BIN = join(binDir, "rclonex");

  db = await import("../src/db");
  await db.initDb();
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");
  await setSetting("rclonex", "1");
  await setSetting("dry_run", "0");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  engineState = eng.engineState;
});

afterEach(() => {
  engineState.running = false;
});

test("website dumps and torrent collections are skipped after extraction; archives stay in place", async () => {
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives ORDER BY path",
  );
  const byPath = new Map(rows.map((r) => [r.path, { status: r.status, errorKind: r.error_kind }]));
  expect(byPath.get("normal.rar")?.status).toBe("done");
  expect(byPath.get("normal.rar")?.errorKind).toBeNull();
  expect(byPath.get("site.rar")?.status).toBe("skipped");
  expect(byPath.get("site.rar")?.errorKind).toBe("website");
  expect(byPath.get("tor.rar")?.status).toBe("skipped");
  expect(byPath.get("tor.rar")?.errorKind).toBe("torrent");

  // The skipped archives were extracted, then the tree was purged, and the
  // archives were never moved to trash.
  const rxLog = readLog(rclonexLog);
  expect(rxLog).toContain("site.rar");
  const log = readLog(rcloneLog);
  expect(log).toContain("purge");
  expect(log).not.toMatch(/moveto[^\n]*site\.rar/);
  expect(log).not.toMatch(/moveto[^\n]*tor\.rar/);
  expect(log).toMatch(/moveto[^\n]*normal\.rar/);
}, 10_000);

test("dry-run does not run the post-extraction skip logic", async () => {
  await db!.store.run("DELETE FROM archives");
  await setSetting("dry_run", "1");
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  for (const row of rows) {
    expect(row.status).toBe("done");
  }
  await setSetting("dry_run", "0");
}, 10_000);
