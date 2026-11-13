import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, appendFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let setSetting: typeof import("../src/db").setSetting;
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
  const base = mkdtempSync(join(tmpdir(), "rx-rclonex-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  rcloneLog = join(base, "rclone.log");
  rclonexLog = join(base, "rclonex.log");

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const common = `if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$*" in
    *--recursive*)
      echo "./big.rar;1000000"
      echo "./set.part1.rar;300000"
      echo "./set.part2.rar;400000"
      echo "./big.7z;1000000"
      echo "./big.iso;1000000"
      echo "./big.zip;1000000"
      exit 0 ;;
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
  const rcloneScript = `#!/bin/sh
echo "rclone $*" >> "${rcloneLog}"
${common}`;
  const rclonexScript = `#!/bin/sh
echo "rclonex $*" >> "${rclonexLog}"
${common}`;
  writeFileSync(join(binDir, "rclone"), rcloneScript);
  writeFileSync(join(binDir, "rclonex"), rclonexScript);
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

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
});

test("rclonex handles rar/7z/iso, rclone handles zip; only first multivolume volume is queued", async () => {
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  const byPath = new Map(rows.map((r) => [r.path, r.status]));
  expect(byPath.get("big.rar")).toBe("done");
  expect(byPath.get("big.7z")).toBe("done");
  expect(byPath.get("big.iso")).toBe("done");
  expect(byPath.get("big.zip")).toBe("done");
  expect(byPath.get("set.part1.rar")).toBe("done");
  // The second volume is never queued.
  expect(byPath.has("set.part2.rar")).toBe(false);

  const rxLog = readLog(rclonexLog);
  expect(rxLog).toContain("archive extract");
  expect(rxLog).toContain("big.rar");
  expect(rxLog).toContain("big.7z");
  expect(rxLog).toContain("big.iso");
  expect(rxLog).toContain("set.part1.rar");
  expect(rxLog).not.toContain("big.zip");

  const rcLog = readLog(rcloneLog);
  expect(rcLog).toContain("archive extract");
  expect(rcLog).toContain("big.zip");
  const rcExtracts = rcLog
    .split("\n")
    .filter((l) => l.includes("archive extract"));
  expect(rcExtracts.some((l) => l.includes("big.zip"))).toBe(true);
  expect(rcExtracts.some((l) => /big\.(rar|7z|iso)/.test(l))).toBe(false);
  expect(rcExtracts.some((l) => l.includes("set.part1.rar"))).toBe(false);
});

test("inspection is skipped for rclonex formats by default, kept for zip", async () => {
  resetLogs();
  await runEngine();
  const rxLog = readLog(rclonexLog);
  const rcLog = readLog(rcloneLog);
  // rclonex formats: no archive list call at all.
  expect(rxLog).not.toContain("archive list");
  // Zip still inspected through rclone.
  expect(rcLog).toContain("archive list");
});

test("inspection runs through rclone (never rclonex) when the skip is disabled", async () => {
  resetLogs();
  await setSetting("rclonex_skip_inspection", "0");
  await runEngine();
  const rxLog = readLog(rclonexLog);
  // rclonex gets no `archive list` — upstream rclone lists RAR/7Z itself.
  expect(rxLog).not.toContain("archive list");
  const rcLog = readLog(rcloneLog);
  expect(rcLog).toContain("archive list");
  expect(rcLog).toContain("big.rar");
  await setSetting("rclonex_skip_inspection", "1");
});

test("ISO archives skip inspection even when inspection is enabled", async () => {
  resetLogs();
  await setSetting("rclonex_skip_inspection", "0");
  await runEngine();
  const isoLists = readLog(rcloneLog)
    .split("\n")
    .filter((l) => l.includes("archive list") && /big\.iso/.test(l));
  expect(isoLists).toEqual([]);
  const rows = await db!.store.query<{ status: string }>(
    "SELECT status FROM archives WHERE path = 'big.iso'",
  );
  // Not "skipped (unreadable)" — extraction proceeds normally.
  expect(rows[0]?.status).toBe("done");
  await setSetting("rclonex_skip_inspection", "1");
});

test("rclonex flags land on the extraction command line", async () => {
  resetLogs();
  await setSetting("rclonex_window_size_enabled", "1");
  await setSetting("rclonex_window_size", "4194304");
  await setSetting("rclonex_archive_password_enabled", "1");
  await setSetting("rclonex_archive_password", "hunter2");
  await runEngine();
  const rxLog = readLog(rclonexLog);
  expect(rxLog).toContain("--archive-window-size 4194304");
  expect(rxLog).toContain("--archive-password hunter2");
  const rcLog = readLog(rcloneLog);
  expect(rcLog).not.toContain("--archive-password");
  await setSetting("rclonex_window_size_enabled", "0");
  await setSetting("rclonex_archive_password_enabled", "0");
});

test("when rclonex is disabled the rar/7z/iso formats are not queued", async () => {
  await db!.store.run("DELETE FROM archives");
  await setSetting("rclonex", "0");
  resetLogs();
  await runEngine();
  const rows = await db!.store.query<{ path: string }>(
    "SELECT path FROM archives ORDER BY path",
  );
  expect(rows.map((r) => r.path)).toEqual(["big.zip"]);
  expect(readLog(rclonexLog)).toBe("");
  await setSetting("rclonex", "1");
});
