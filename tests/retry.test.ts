import { test, expect, beforeAll, beforeEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * Retry behavior is driven through a real engine run with stub binaries. The
 * stubs log every invocation and fail commands only when a marker says so, so
 * the tests observe command counts, the run log and the archive status.
 */
let parseCooldownSeconds: typeof import("../src/engine").parseCooldownSeconds;
let retryDelays: typeof import("../src/engine").retryDelays;
let getSetting: typeof import("../src/db").getSetting;
let setSetting: typeof import("../src/db").setSetting;
let store: typeof import("../src/db").store;
let runEngine: typeof import("../src/engine").runEngine;
let engineState: typeof import("../src/engine").engineState;
let requestSkipArchive: typeof import("../src/engine").requestSkipArchive;
let forceStopEngine: typeof import("../src/engine").forceStopEngine;
let readAll: typeof import("../src/log").readAll;
let app: Hono;

let base = "";
let markDir = "";
let rcloneLog = "";
let rclonexLog = "";

function writeMark(name: string, content: string): void {
  writeFileSync(join(markDir, name), content);
}
function rmMark(name: string): void {
  rmSync(join(markDir, name), { force: true });
}
function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function resetLogs(): void {
  rmSync(rcloneLog, { force: true });
  rmSync(rclonexLog, { force: true });
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
async function runLogText(): Promise<string> {
  const lines = await readAll({ scope: "run", refId: engineState.runId, kind: "main" });
  return lines.join("\n");
}
async function archiveRow(path: string): Promise<{ status: string; errorKind: string | null }> {
  const row = await store.get1<{ status: string; error_kind: string | null }>(
    "SELECT status, error_kind FROM archives WHERE path=?",
    [path],
  );
  return { status: row?.status ?? "", errorKind: row?.error_kind ?? null };
}

const stubScript = (label: string, log: string) => `#!/bin/sh
M="${markDir}"
echo "${label} $*" >> "${log}"
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$*" in
    *Rclone-Extractor-tmp*) cat "$M/list_out" 2>/dev/null; exit 0 ;;
    *) cat "$M/scan_out" 2>/dev/null; exit 0 ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  cat "$M/list_out" 2>/dev/null; exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  f="$M/fail_extract"
  if [ -f "$f" ]; then
    n=$(cat "$f")
    c="$M/count_extract"
    k=$(cat "$c" 2>/dev/null || echo 0)
    k=$((k+1)); echo "$k" > "$c"
    if [ "$k" -le "$n" ]; then
      cat "$M/extract_err" 2>/dev/null || echo "transient extract failure" >&2
      exit 1
    fi
  fi
  exit 0
fi
if [ "$1" = "move" ] || [ "$1" = "moveto" ]; then
  cmd="$1"
  f="$M/fail_$cmd"
  if [ -f "$f" ]; then
    n=$(cat "$f")
    c="$M/count_$cmd"
    k=$(cat "$c" 2>/dev/null || echo 0)
    k=$((k+1)); echo "$k" > "$c"
    if [ "$k" -le "$n" ]; then
      echo "transient $cmd failure" >&2
      exit 1
    fi
  fi
fi
exit 0
`;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "rx-retry-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  const binDir = join(base, "bin");
  markDir = join(base, "marks");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(markDir, { recursive: true });
  mkdirSync(join(base, "scan"), { recursive: true });
  rcloneLog = join(base, "rclone.log");
  rclonexLog = join(base, "rclonex.log");
  writeFileSync(join(binDir, "rclone"), stubScript("rclone", rcloneLog), { mode: 0o755 });
  writeFileSync(join(binDir, "rclonex"), stubScript("rclonex", rclonexLog), { mode: 0o755 });
  chmodSync(join(binDir, "rclone"), 0o755);
  chmodSync(join(binDir, "rclonex"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.RCLONEX_BIN = join(binDir, "rclonex");

  const eng = await import("../src/engine");
  parseCooldownSeconds = eng.parseCooldownSeconds;
  retryDelays = eng.retryDelays;
  runEngine = eng.runEngine;
  engineState = eng.engineState;
  requestSkipArchive = eng.requestSkipArchive;
  forceStopEngine = eng.forceStopEngine;

  const db = await import("../src/db");
  store = db.store;
  getSetting = db.getSetting;
  setSetting = db.setSetting;
  await db.initDb();
  await setSetting("scan_root", join(base, "scan"));
  await setSetting("remote_flags", "");
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");
  readAll = (await import("../src/log")).readAll;

  const { actions } = await import("../src/routes/actions");
  app = new Hono();
  app.route("/", actions);
});

beforeEach(async () => {
  await store.run("DELETE FROM log_lines");
  await store.run("DELETE FROM archives");
  await store.run("DELETE FROM runs");
  for (const name of [
    "fail_extract", "fail_move", "fail_moveto", "extract_err",
    "count_extract", "count_move", "count_moveto",
  ]) {
    rmMark(name);
  }
  writeMark("scan_out", "./one.zip;100000\n");
  writeMark("list_out", "40000 ./big.bin\n");
  resetLogs();
  await setSetting("retry_cooldown_seconds", "60");
  await setSetting("scan_cache_key", "");
  await setSetting("scan_cache_state", "incomplete");
  engineState.running = false;
});

test("retry cooldown parses strict whole seconds", () => {
  expect(parseCooldownSeconds("0")).toBe(0);
  expect(parseCooldownSeconds("60")).toBe(60);
  expect(parseCooldownSeconds("86400")).toBe(86400);
  expect(parseCooldownSeconds(" 15 ")).toBe(15);
  for (const bad of ["", " ", "1.5", "-1", "86401", "abc", "60s", null, undefined]) {
    expect(parseCooldownSeconds(bad)).toBeNull();
  }
});

test("retry delays double each time", () => {
  expect(retryDelays(1000)).toEqual([1000, 2000, 4000]);
});

test("config rejects an invalid retry cooldown and stores a valid one normalized", async () => {
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("60");

  const bad = new FormData();
  bad.append("retry_cooldown_seconds", "60.5");
  const badRes = await app.request("/config", { method: "POST", body: bad });
  expect(badRes.status).toBe(200);
  expect(await badRes.text()).toContain("retry_cooldown_seconds must be a whole number");
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("60");

  const good = new FormData();
  good.append("retry_cooldown_seconds", " 15 ");
  const goodRes = await app.request("/config", { method: "POST", body: good });
  expect(goodRes.status).toBe(200);
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("15");
});

test("extract is attempted four times with a doubling cooldown", async () => {
  await setSetting("retry_cooldown_seconds", "1");
  writeMark("fail_extract", "99");
  const started = Date.now();
  await runEngine();
  const elapsed = Date.now() - started;

  expect(await archiveRow("one.zip")).toEqual({ status: "failed", errorKind: "extract" });
  expect(count(readLog(rclonexLog), "archive extract")).toBe(4);
  const log = await runLogText();
  expect(log).toContain("retry 1/3 after 1s: extract one.zip");
  expect(log).toContain("retry 2/3 after 2s: extract one.zip");
  expect(log).toContain("retry 3/3 after 4s: extract one.zip");
  // The waits really happened. The log lines only describe them.
  expect(elapsed).toBeGreaterThan(6500);
}, 20_000);

test("a password failure skips immediately without a retry", async () => {
  await setSetting("retry_cooldown_seconds", "1");
  writeMark("fail_extract", "99");
  writeMark("extract_err", "password required");
  await runEngine();

  expect(await archiveRow("one.zip")).toEqual({ status: "skipped", errorKind: "password" });
  expect(count(readLog(rclonexLog), "archive extract")).toBe(1);
  expect(await runLogText()).not.toContain("retry 1/3");
});

test("a website skip after extraction is not retried", async () => {
  await setSetting("retry_cooldown_seconds", "1");
  writeMark("scan_out", "./site.rar;100000\n");
  writeMark("list_out", "./index.html;100\n./style.css;100\n");
  await runEngine();

  expect(await archiveRow("site.rar")).toEqual({ status: "skipped", errorKind: "website" });
  expect(count(readLog(rclonexLog), "archive extract")).toBe(1);
  expect(await runLogText()).not.toContain("retry 1/3");
});

test("a failed extract keeps resume data for the retry and purges it after success", async () => {
  await setSetting("retry_cooldown_seconds", "0");
  writeMark("fail_extract", "1");
  await runEngine();

  expect(await archiveRow("one.zip")).toEqual({ status: "done", errorKind: null });
  const xLines = readLog(rclonexLog).split("\n");
  const extracts = xLines.flatMap((l, i) => (l.includes("archive extract") ? [i] : []));
  expect(extracts.length).toBe(2);
  const rcLines = readLog(rcloneLog).split("\n");
  const resumePurges = rcLines.flatMap((l, i) =>
    l.includes(" purge ") && l.includes("/resume/") ? [i] : [],
  );
  expect(resumePurges.length).toBe(1);
  expect(resumePurges[0]).toBeGreaterThan(extracts[1]);
});

test("resume data survives every retry and is purged once the extract fails", async () => {
  await setSetting("retry_cooldown_seconds", "0");
  writeMark("fail_extract", "99");
  await runEngine();

  expect(await archiveRow("one.zip")).toEqual({ status: "failed", errorKind: "extract" });
  const lines = readLog(rclonexLog).split("\n");
  const extracts = lines.flatMap((l, i) => (l.includes("archive extract") ? [i] : []));
  expect(extracts.length).toBe(4);
  const rcLines = readLog(rcloneLog).split("\n");
  const resumePurges = rcLines.flatMap((l, i) =>
    l.includes(" purge ") && l.includes("/resume/") ? [i] : [],
  );
  // No purge between attempts; the failed outcome is the only trigger.
  expect(resumePurges.length).toBe(1);
  expect(resumePurges[0]).toBeGreaterThan(extracts[3]);
});

test("promote and trash failures are retried too", async () => {
  await setSetting("retry_cooldown_seconds", "0");
  writeMark("fail_move", "2");
  writeMark("fail_moveto", "1");
  await runEngine();

  const log = readLog(rcloneLog);
  expect(count(log, " move ")).toBe(3);
  expect(count(log, " moveto ")).toBe(2);
  expect(await archiveRow("one.zip")).toEqual({ status: "done", errorKind: null });
});

test("a skip during cooldown aborts the wait and re-queues immediately", async () => {
  await setSetting("retry_cooldown_seconds", "5");
  writeMark("fail_extract", "99");
  const running = runEngine();
  const deadline = Date.now() + 5000;
  let sawRetry = false;
  while (Date.now() < deadline) {
    if ((await runLogText()).includes("retry 1/3")) {
      sawRetry = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(sawRetry).toBe(true);
  expect(requestSkipArchive()).toBe(true);
  const abortedAt = Date.now();
  await running;

  expect(Date.now() - abortedAt).toBeLessThan(3000);
  expect(count(readLog(rclonexLog), "archive extract")).toBe(1);
  expect(await archiveRow("one.zip")).toEqual({ status: "queued", errorKind: null });
}, 15_000);

test("a hard stop during cooldown aborts the wait and re-queues immediately", async () => {
  await setSetting("retry_cooldown_seconds", "5");
  writeMark("fail_extract", "99");
  const running = runEngine();
  const deadline = Date.now() + 5000;
  let sawRetry = false;
  while (Date.now() < deadline) {
    if ((await runLogText()).includes("retry 1/3")) {
      sawRetry = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(sawRetry).toBe(true);
  forceStopEngine();
  const abortedAt = Date.now();
  await running;

  expect(Date.now() - abortedAt).toBeLessThan(3000);
  expect(count(readLog(rclonexLog), "archive extract")).toBe(1);
  expect(await archiveRow("one.zip")).toEqual({ status: "queued", errorKind: null });
}, 15_000);
