import { test, expect, beforeAll, beforeEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * Per-subcommand extra flags. Every assertion drives a real stub binary and
 * reads what it received, so a flag landing on the wrong command is visible.
 */
const KEYS = [
  "lsf_extra_flags",
  "archive_list_extra_flags",
  "extract_extra_flags",
  "rclonex_extract_extra_flags",
  "move_extra_flags",
  "moveto_extra_flags",
  "cat_extra_flags",
  "lsl_extra_flags",
  "lsjson_extra_flags",
  "purge_extra_flags",
] as const;

const MARK: Record<string, string> = {
  lsf_extra_flags: "MARK-lsf",
  archive_list_extra_flags: "MARK-archive-list",
  extract_extra_flags: "MARK-extract",
  rclonex_extract_extra_flags: "MARK-rclonex-extract",
  move_extra_flags: "MARK-promote",
  moveto_extra_flags: "MARK-moveto",
  cat_extra_flags: "MARK-cat",
  lsl_extra_flags: "MARK-lsl",
  lsjson_extra_flags: "MARK-lsjson",
  purge_extra_flags: "MARK-purge",
};

let db: typeof import("../src/db");
let Rclone: typeof import("../src/rclone").Rclone;
let engine: typeof import("../src/engine");
let app: Hono;
let dataApp: Hono;
let base: string;
let scanRoot: string;
let rcloneLog: string;
let rclonexLog: string;
const ref = { scope: "archive" as const, refId: 1, kind: "extract" as const };

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function calls(path: string): string[] {
  return read(path).split("\n").filter((l) => l.startsWith("rclone ") || l.startsWith("rclonex "));
}
function resetLogs(): void {
  rmSync(rcloneLog, { force: true });
  rmSync(rclonexLog, { force: true });
}
function oneCall(path: string, fragment: string): string {
  const found = calls(path).filter((l) => l.includes(fragment));
  expect(found.length).toBe(1);
  return found[0];
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "rx-extraflags-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  rcloneLog = join(base, "rclone.log");
  rclonexLog = join(base, "rclonex.log");
  const binDir = join(base, "bin");
  scanRoot = join(base, "scan");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scanRoot, { recursive: true });

  const help = (extra: string) => `    printf '%s\\n' \\
      '--fast-list       Recursive listing.' \\
      '--transfers=N     Transfer count.' \\
      '--verbose         Verbose output.' \\
      '--stats=N         Stats interval.' \\
      '--config=FILE     Config file.' \\
      '--help            Help.' \\
      '  -v, --verbose    Short verbose.'${extra}
    exit 0`;
  const common = (label: string, log: string, helpExtra: string) => `#!/bin/sh
case "$*" in
  *--help*|"help flags") ;;
  *) echo "${label} $*" >> "${log}" ;;
esac
if [ "$1" = "--config" ]; then shift 2; fi
case "$*" in
  *--help*|"help flags")
${help(helpExtra)}
    ;;
esac
if [ "$1" = "lsf" ]; then
  case "$*" in
    *--dirs-only*) printf 'run_123/\\n'; exit 0 ;;
    *) printf './seeded.zip;100000\\n'; exit 0 ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '1000 ./inner.bin\\n'; exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then exit 0; fi
if [ "$1" = "cat" ]; then printf 'PAYLOAD'; exit 0; fi
if [ "$1" = "lsl" ]; then printf '/root/seeded.zip\\n'; exit 0; fi
if [ "$1" = "lsjson" ]; then printf '[{"Path":"seeded.zip","Size":100000,"IsDir":false}]\\n'; exit 0; fi
exit 0
`;
  const rclonePath = join(binDir, "rclone");
  const rclonexPath = join(binDir, "rclonex");
  writeFileSync(rclonePath, common("rclone", rcloneLog, ""), { mode: 0o755 });
  writeFileSync(rclonexPath, common("rclonex", rclonexLog, `
      '--archive-password=PASS  Archive password.' \\
      '--archive-window-size=N  Window size.'`), { mode: 0o755 });
  chmodSync(rclonePath, 0o755);
  chmodSync(rclonexPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.RCLONE_BIN = rclonePath;
  process.env.RCLONEX_BIN = rclonexPath;

  db = await import("../src/db");
  await db.initDb();
  await db.setSetting("scan_root", scanRoot);
  await db.setSetting("min_archive_size", "0");
  await db.setSetting("max_archive_size", "0");
  await db.store.run(
    "INSERT INTO archives(id, path, size, status, created_at, updated_at) VALUES(1, 'seeded.zip', 100000, 'queued', 't', 't')",
  );

  const rc = await import("../src/rclone");
  Rclone = rc.Rclone;
  engine = await import("../src/engine");
  const actions = await import("../src/routes/actions");
  const data = await import("../src/routes/data");
  app = new Hono();
  app.route("/", actions.actions);
  dataApp = new Hono();
  dataApp.route("/", data.data);
});

beforeEach(async () => {
  resetLogs();
  for (const key of KEYS) await db.setSetting(key, "");
  await db.setSetting("scan_cache_key", "");
  await db.setSetting("scan_cache_state", "incomplete");
});

async function setAllMarkers(skip: string[] = []): Promise<void> {
  for (const key of KEYS) {
    if (skip.includes(key)) continue;
    await db.setSetting(key, `--transfers ${MARK[key]}`);
  }
}

test("each rclone command receives only its own extra flags", async () => {
  await setAllMarkers();
  const rc = await Rclone.fromSettings();
  await rc.listPath("root", () => {});
  await rc.listTopDirs("root");
  await rc.archiveList("seeded.zip", ref, () => {});
  await rc.extract("seeded.zip", "tmp", ref);
  await rc.promote("seeded.zip", "tmp", ref, null);
  await rc.trash("seeded.zip", ".Trash", ref);
  await rc.moveToRel("seeded.zip", ".Trash/seeded.zip", ref);
  const cat = await rc.openCat("seeded.zip");
  await new Response(cat.stdout).text();
  await cat.exited;
  await rc.existsPath("seeded.zip");
  await rc.statFile("seeded.zip");
  await rc.purge("tmp");
  await rc.cleanup("tmp", ref);
  await rc.run(["version"]);

  const expectFor: Array<[string, string]> = [
    [" lsf ", "MARK-lsf"],
    [" archive list ", "MARK-archive-list"],
    [" archive extract ", "MARK-extract"],
    [" move ", "MARK-promote"],
    [" moveto ", "MARK-moveto"],
    [" cat ", "MARK-cat"],
    [" lsl ", "MARK-lsl"],
    [" lsjson ", "MARK-lsjson"],
    [" purge ", "MARK-purge"],
  ];
  for (const [fragment, marker] of expectFor) {
    const found = calls(rcloneLog).filter((l) => l.includes(fragment));
    expect(found.length).toBeGreaterThan(0);
    for (const line of found) {
      expect(line).toContain(marker);
      for (const other of Object.values(MARK)) {
        if (other !== marker) expect(line).not.toContain(other);
      }
    }
  }
  const version = oneCall(rcloneLog, " version");
  for (const marker of Object.values(MARK)) expect(version).not.toContain(marker);
}, 15_000);

test("moveto never inherits flags from another group or the legacy key", async () => {
  await setAllMarkers(["moveto_extra_flags"]);
  await db.setSetting("remote_flags", "--fast-list LEGACY-LEAK");
  const rc = await Rclone.fromSettings();
  await rc.trash("seeded.zip", ".Trash", ref);
  await rc.moveToRel("seeded.zip", ".Trash/seeded.zip", ref);
  const moves = calls(rcloneLog).filter((l) => l.includes(" moveto "));
  expect(moves.length).toBe(2);
  for (const line of moves) {
    for (const marker of Object.values(MARK)) expect(line).not.toContain(marker);
    expect(line).not.toContain("LEGACY-LEAK");
  }
}, 15_000);

test("rclonex extract uses only its own field plus code-controlled flags", async () => {
  await setAllMarkers();
  const rx = await Rclone.fromSettings(undefined, { rclonex: true });
  await rx.extract("seeded.zip", "tmp", ref, undefined, [
    "--archive-password",
    "hunter2",
  ]);
  const line = oneCall(rclonexLog, " archive extract ");
  expect(line).toContain("MARK-rclonex-extract");
  expect(line).not.toContain("MARK-extract");
  expect(line).toContain("--archive-password hunter2");
  expect(calls(rcloneLog).some((l) => l.includes("MARK-rclonex-extract"))).toBe(false);
}, 15_000);

test("config save rejects a flag unknown to the installed binary", async () => {
  const form = new FormData();
  form.append("extract_extra_flags", "--totally-unknown-flag x");
  const res = await app.request("/config", { method: "POST", body: form });
  const body = await res.text();
  expect(body).toContain("Unknown rclone flag");
  expect(res.headers.get("HX-Trigger")).toContain("err");
  expect(await db.getSetting("extract_extra_flags")).toBe("");
}, 15_000);

test("config save accepts a flag listed in the installed binary's help", async () => {
  const form = new FormData();
  form.append("extract_extra_flags", "--fast-list");
  const res = await app.request("/config", { method: "POST", body: form });
  const body = await res.text();
  expect(body).toContain("Saved.");
  expect(await db.getSetting("extract_extra_flags")).toBe("--fast-list");
}, 15_000);

test("config save keeps --config out of the stored flags", async () => {
  const form = new FormData();
  form.append("extract_extra_flags", "--config /tmp/evil.conf --fast-list");
  const res = await app.request("/config", { method: "POST", body: form });
  expect(await res.text()).toContain("Saved.");
  resetLogs();
  const rc = await Rclone.fromSettings();
  await rc.extract("seeded.zip", "tmp", ref);
  const line = oneCall(rcloneLog, " archive extract ");
  expect(line).not.toContain("/tmp/evil.conf");
  expect(line).toContain("--config"); // the app's own working copy
}, 15_000);

test("legacy remote_flags migrates once into only extract, move and cat", async () => {
  await db.store.run("INSERT OR REPLACE INTO settings(key, value) VALUES('remote_flags', '--legacy-migrate')", []);
  await db.initDb();
  expect(await db.getSetting("extract_extra_flags")).toBe("--legacy-migrate");
  expect(await db.getSetting("move_extra_flags")).toBe("--legacy-migrate");
  expect(await db.getSetting("cat_extra_flags")).toBe("--legacy-migrate");
  expect(await db.getSetting("lsf_extra_flags")).toBe("");
  expect(await db.getSetting("remote_flags")).toBeUndefined();

  // Re-running is idempotent and copy-if-empty preserves a real value.
  await db.setSetting("extract_extra_flags", "--keep-me");
  await db.setSetting("move_extra_flags", "");
  await db.setSetting("cat_extra_flags", "");
  await db.store.run("INSERT OR REPLACE INTO settings(key, value) VALUES('remote_flags', '--legacy-2')", []);
  await db.initDb();
  expect(await db.getSetting("extract_extra_flags")).toBe("--keep-me");
  expect(await db.getSetting("move_extra_flags")).toBe("--legacy-2");
  expect(await db.getSetting("cat_extra_flags")).toBe("--legacy-2");
}, 15_000);

test("importing an old backup maps remote_flags without losing explicit fields", async () => {
  await db.setSetting("move_extra_flags", "--existing-move");
  const backup = {
    version: 1,
    settings: {
      remote_flags: "--legacy-import",
      cat_extra_flags: "--explicit-cat",
    },
    archives: [],
    runs: [],
    log_lines: [],
  };
  const form = new FormData();
  form.append(
    "archive",
    new File([JSON.stringify(backup)], "old.json", { type: "application/json" }),
  );
  const res = await dataApp.request("/import", { method: "POST", body: form });
  expect((await res.json() as { ok: boolean }).ok).toBe(true);
  expect(await db.getSetting("extract_extra_flags")).toBe("--legacy-import");
  expect(await db.getSetting("move_extra_flags")).toBe("--existing-move");
  expect(await db.getSetting("cat_extra_flags")).toBe("--explicit-cat");
  expect(await db.store.get1("SELECT value FROM settings WHERE key = 'remote_flags'")).toBeNull();
}, 15_000);

test("a bad stored flag stops the run once instead of failing every archive", async () => {
  await db.setSetting("extract_extra_flags", "--not-installed bad");
  await db.store.run(
    "UPDATE archives SET status='queued' WHERE id=1",
  );
  await engine.runEngine();
  expect(engine.engineState.stage).toBe("error");
  expect(engine.engineState.errorKind).toBe("invalid_extra_flags");
  expect(engine.engineState.lastError).toContain("extract_extra_flags");
  expect(engine.engineState.lastError).toContain("--not-installed");
  expect(calls(rcloneLog).some((l) => l.includes(" archive extract "))).toBe(false);
}, 15_000);
