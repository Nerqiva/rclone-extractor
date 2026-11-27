import { test, expect, beforeAll } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveIncludePatterns, isSupported } from "../src/archive";

const NATIVE = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.lz4",
  ".tar.xz",
  ".tar.zst",
  ".tar.br",
  ".tar.sz",
  ".tar.mz",
  ".tar.lz",
  ".tgz",
  ".taz",
  ".tb2",
  ".tbz",
  ".tbz2",
  ".tz2",
  ".txz",
  ".tzst",
  ".zip",
  ".tar",
];
const RCLONEX_ONLY = ["*.rar", "*.7z", "*.7z.[0-9][0-9][0-9]", "*.iso"];

// Emulates rclone's glob matching with --ignore-case: a pattern without a
// slash matches from the end of the path at a complete path-element boundary.
function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      out += "[^/]*";
      i++;
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "[") {
      const end = glob.indexOf("]", i);
      out += glob.slice(i, end + 1);
      i = end + 1;
    } else if ("\\^$+{}()|.".includes(ch)) {
      out += `\\${ch}`;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return new RegExp(`(^|/)${out}$`, "i");
}

function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some((p) => globToRegex(p).test(path));
}

test("patterns are exactly the supported suffixes, in order", () => {
  expect(archiveIncludePatterns()).toEqual([
    ...NATIVE.map((s) => `*${s}`),
    ...RCLONEX_ONLY,
  ]);
});

test("every isSupported true-case matches a glob (no false negatives)", () => {
  const nativeNames = NATIVE.flatMap((s) => [
    `x${s}`,
    `deep/nested/y${s}`,
    `UPPER${s.toUpperCase()}`,
  ]);
  for (const name of nativeNames) {
    expect(matchesAny(archiveIncludePatterns(), name)).toBe(true);
    expect(isSupported(name)).toBe(true);
  }
  const rclonexNames = [
    "x.rar",
    "x.RAR",
    "x.part1.rar",
    "x.part01.rar",
    "x.7z",
    "x.7Z",
    "x.7z.001",
    "dir/X.7Z.001",
    "x.iso",
    "x.ISO",
  ];
  for (const name of rclonexNames) {
    expect(matchesAny(archiveIncludePatterns(), name)).toBe(true);
    expect(isSupported(name)).toBe(true);
  }
});

test("non-archives and other-volume files are not hidden by the globs", () => {
  const neverMatch = [
    "notes.txt",
    "image.png",
    "video.mp4",
    "x.r00", // old-style volumes are never queueable
    "x.r99",
    "file.tar.gz.bak",
    "x.7z.bak",
    "nomatch.txt.gz",
  ];
  for (const name of neverMatch) {
    expect(matchesAny(archiveIncludePatterns(), name)).toBe(false);
  }
  // .rNN is not matched even with rclonex enabled (first volume is the .rar)
  expect(matchesAny(archiveIncludePatterns(), "x.r00")).toBe(false);
});

test("multivolume globs are broad; first-volume selection stays in-app", () => {
  const patterns = archiveIncludePatterns();
  // Listed (so the app can decide) but never queueable by themselves.
  expect(matchesAny(patterns, "x.part2.rar")).toBe(true);
  expect(isSupported("x.part2.rar")).toBe(false);
  expect(matchesAny(patterns, "x.7z.999")).toBe(true);
  expect(isSupported("x.7z.999")).toBe(false);
  expect(matchesAny(patterns, "x.part01.rar")).toBe(true);
  expect(isSupported("x.part01.rar")).toBe(true);
});

let db: typeof import("../src/db") | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let engineState: typeof import("../src/engine").engineState;
let readAll: typeof import("../src/log").readAll;

const MB = 1024 * 1024;
const argvMarker = join(mkdtempSync(join(tmpdir(), "rx-scanflt-argv-")), "argv.txt");

beforeAll(async () => {
  rmSync(argvMarker, { force: true });
  const base = mkdtempSync(join(tmpdir(), "rx-scanflt-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  // The mock prints everything: rclone-side filtering is not emulated, which
  // proves the app-side backstop still enforces the size window and the
  // archive filter.
  const script = `#!/bin/sh
# strip leading hard-coded --config <path> pair
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  echo "$*" >> "${argvMarker}"
  echo "./edge.zip;${MB}"
  echo "./limit.zip;${5 * MB}"
  echo "./toobig.zip;${6 * MB}"
  echo "./toosmall.zip;100"
  echo "./notes.txt;100000"
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
  const setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  // 1 MB min / 5 MB max; edge.zip (exactly 1 MB) and limit.zip (exactly
  // 5 MB) are kept, toobig/toosmall dropped.
  await setSetting("min_archive_size", String(MB));
  await setSetting("max_archive_size", String(5 * MB));

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  engineState = eng.engineState;
  readAll = (await import("../src/log")).readAll;

  await runEngine();
});

test("lsf is spawned with ignore-case, includes and byte size filters", () => {
  expect(existsSync(argvMarker)).toBe(true);
  const argv = readFileSync(argvMarker, "utf8");
  expect(argv).toContain("--ignore-case");
  expect(argv).toContain("--include *.zip");
  expect(argv).toContain("--include *.tar.gz");
  expect(argv).toContain(`--min-size ${MB}B`);
  expect(argv).toContain(`--max-size ${5 * MB}B`);
  // RcloneX formats are always included now.
  expect(argv).toContain("*.rar");
  expect(argv).toContain("*.iso");
});

test("archives at exactly the size limits are kept", async () => {
  const rows = await db!.store.query<{ path: string; status: string }>(
    "SELECT path, status FROM archives ORDER BY path",
  );
  const byPath = new Map(rows.map((r) => [r.path, r.status]));
  expect(byPath.get("edge.zip")).toBe("done");
  expect(byPath.get("limit.zip")).toBe("done");
});

test("out-of-range and non-archive files are still dropped in-app", async () => {
  const rows = await db!.store.query<{ path: string }>(
    "SELECT path FROM archives",
  );
  expect(rows.some((r) => r.path === "toobig.zip")).toBe(false);
  expect(rows.some((r) => r.path === "toosmall.zip")).toBe(false);
  expect(rows.some((r) => r.path === "notes.txt")).toBe(false);
});

test("run log records the listing filters line", async () => {
  const main = await readAll({
    scope: "run",
    refId: engineState.runId,
    kind: "main",
  });
  expect(main.some((line) => line.includes("listing filters:"))).toBe(true);
});
