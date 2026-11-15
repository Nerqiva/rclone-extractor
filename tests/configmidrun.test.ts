import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createHash } from "node:crypto";

/**
 * Behavior while a run is active:
 *
 * - The Configuration settings form saves against the database (the run is
 *   not affected — it pins its own rclone.conf snapshot at start).
 * - rclone.conf saves/clears made mid-run sync the shared working copy
 *   immediately (on-demand rclone calls and the next run see the new conf),
 *   while the in-flight run keeps using its private snapshot taken at run
 *   start — every command it spawns carries the snapshot's --config path.
 * - The snapshot file is deleted when the run ends.
 * - Destructive maintenance actions (Clear logs, Clear tmp, Clear
 *   everything) stay blocked; Import stays blocked.
 */

const OLD_CONF = "[oldremote]\ntype = sftp\nhost = old.example.com\n";
const NEW_CONF = "[newremote]\ntype = sftp\nhost = new.example.com\n";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

let db:
  | typeof import("../src/db")
  | null = null;
let engine: typeof import("../src/engine");
let setSetting: typeof import("../src/db").setSetting;
let getSetting: typeof import("../src/db").getSetting;
let app: Hono;
let dataDir: string;
let scanRoot: string;
let rcloneLog: string;

function readLog(): string {
  return existsSync(rcloneLog) ? readFileSync(rcloneLog, "utf8") : "";
}
function resetLogs() {
  rmSync(rcloneLog, { force: true });
}
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
/** --config path and sha lines recorded by the stub for every invocation. */
function confLines(log: string): string[] {
  return log.split("\n").filter((l) => l.startsWith("conf "));
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rx-midrun-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;
  rcloneLog = join(dataDir, "rclone.log");

  const binDir = join(dataDir, "bin");
  mkdirSync(binDir, { recursive: true });
  scanRoot = join(dataDir, "scan");
  mkdirSync(scanRoot, { recursive: true });

  // Record the --config path and the conf file's sha for every invocation.
  const rcloneScript = `#!/bin/sh
cfg=""
if [ "$1" = "--config" ]; then cfg="$2"; fi
echo "rclone $*" >> "${rcloneLog}"
if [ -n "$cfg" ] && [ -f "$cfg" ]; then
  printf 'conf %s sha %s\\n' "$cfg" "$(sha1sum "$cfg" | cut -d' ' -f1)" >> "${rcloneLog}"
fi
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '300000 ./big.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  if [ "$RCLONE_STUB_BLOCK" = "extract" ]; then exec sleep 3600; fi
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
  getSetting = db.getSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");
  await setSetting("resume", "0");
  await setSetting("rclone_conf", OLD_CONF);

  const [{ actions }, { data }] = await Promise.all([
    import("../src/routes/actions"),
    import("../src/routes/data"),
  ]);
  app = new Hono();
  app.route("/", actions);
  app.route("/", data);

  engine = await import("../src/engine");
});

beforeEach(async () => {
  resetLogs();
  process.env.RCLONE_STUB_BLOCK = "";
  await db!.store.run("DELETE FROM archives");
  await db!.store.run("DELETE FROM runs");
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  await setSetting("rclone_conf", OLD_CONF);
  engine.engineState.running = false;
  engine.engineState.stage = "idle";
  engine.engineState.activity = "";
  engine.engineState.skipListing = false;
  engine.engineState.skipInspection = false;
  engine.engineState.skipArchive = false;
  engine.engineState.stopRequested = false;
  engine.engineState.forceStop = false;
  engine.engineState.total = 0;
  engine.engineState.done = 0;
  engine.engineState.failed = 0;
  engine.engineState.skipped = 0;
  engine.engineState.runId = 0;
  engine.engineState.currentScanRoot = "";
});

afterEach(() => {
  engine.engineState.running = false;
  process.env.RCLONE_STUB_BLOCK = "";
});

test("settings form saves while a run is active and applies from the next run", async () => {
  engine.engineState.running = true; // no actual run needed for the route
  const form = new FormData();
  form.append("scan_root", join(dataDir, "other-remote"));
  const res = await app.request("/config", { method: "POST", body: form });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("from the next run");
  expect((await getSetting("scan_root", "")) ?? "").toBe(join(dataDir, "other-remote"));
  // the running (pretend) run still sees the old root via its state
  await setSetting("scan_root", scanRoot);
}, 10_000);

test("rclone.conf saves mid-run sync the shared working copy but the run keeps its snapshot", async () => {
  await db!.store.run(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('seeded.zip', 100000, 'queued', 't', 't')",
  );
  resetLogs();
  process.env.RCLONE_STUB_BLOCK = "extract";
  const running = engine.runEngine();
  const sawExtract = await waitFor(() => engine.engineState.activity === "Extracting");
  expect(sawExtract).toBe(true);

  // The in-flight run's snapshot exists and holds the OLD conf.
  const snapshots = readdirSync(dataDir).filter((f) => /^run-conf-\d+\.conf$/.test(f));
  expect(snapshots.length).toBe(1);
  expect(readFileSync(join(dataDir, snapshots[0]), "utf8")).toBe(OLD_CONF.trim());

  // Save a new conf mid-run through the real route.
  const form = new FormData();
  form.append("rclone_conf", NEW_CONF);
  const res = await app.request("/config", { method: "POST", body: form });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("from the next run");

  // On-demand ops see the new conf immediately: shared working copy updated.
  // (The multipart layer may convert LF to CRLF, so match loosely.)
  expect(readFileSync(join(dataDir, "rclone.conf"), "utf8")).toContain("new.example.com");

  // Stop the archive so the run completes; its remaining commands must all
  // keep using the private snapshot with the OLD conf.
  expect(engine.requestSkipArchive()).toBe(true);
  await running;

  const log = readLog();
  const conf = confLines(log);
  expect(conf.length).toBeGreaterThan(0);
  for (const line of conf) {
    expect(line).toContain("run-conf-");
    expect(line).toContain(`sha ${sha1(OLD_CONF.trim())}`);
  }
  expect(log).not.toContain(`conf ${join(dataDir, "rclone.conf")}`);

  // The snapshot file is deleted when the run ends.
  expect(readdirSync(dataDir).filter((f) => /^run-conf-\d+\.conf$/.test(f))).toEqual([]);

  // On-demand calls now point at the shared working copy (new conf).
  const rcPathModule = await import("../src/rclone");
  resetLogs();
  const rc = await rcPathModule.Rclone.fromSettings();
  await rc.existsPath("anything");
  const after = confLines(readLog());
  expect(after.length).toBe(1);
  expect(after[0]).toContain(`conf ${join(dataDir, "rclone.conf")}`);
  expect(after[0]).toContain(`sha ${sha1(readFileSync(join(dataDir, "rclone.conf"), "utf8"))}`);
}, 15_000);

test("rclone-clear and rclonex-clear are accepted mid-run", async () => {
  engine.engineState.running = true;
  const res1 = await app.request("/config/rclone-clear", { method: "POST" });
  expect(res1.status).toBe(200);
  expect((await getSetting("rclone_conf", "")) ?? "").toBe("");
  const res2 = await app.request("/config/rclonex-clear", { method: "POST" });
  expect(res2.status).toBe(200);
  expect((await getSetting("rclonex_archive_password", "")) ?? "").toBe("");
  await setSetting("rclone_conf", OLD_CONF);
}, 10_000);

test("destructive actions stay blocked mid-run", async () => {
  engine.engineState.running = true;
  const resImport = await app.request("/import", { method: "POST" });
  expect(resImport.status).toBe(409);
  const resAll = await app.request("/maintenance/all", { method: "POST" });
  expect(await resAll.text()).toContain("stop it first");
  const resLogs = await app.request("/maintenance/logs", { method: "POST" });
  expect(await resLogs.text()).toContain("stop it first");
  const resTmp = await app.request("/maintenance/tmp-purge", { method: "POST" });
  expect(await resTmp.text()).toContain("stop it first");
}, 10_000);
