import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bounded worker pool. The stub records extract start/end events so the tests
 * can measure real overlap, and can be held mid-extract to drive stop/skip.
 */
let db: typeof import("../src/db") | null = null;
let setSetting: typeof import("../src/db").setSetting;
let runEngine: typeof import("../src/engine").runEngine;
let stopEngine: typeof import("../src/engine").stopEngine;
let forceStopEngine: typeof import("../src/engine").forceStopEngine;
let requestSkipArchive: typeof import("../src/engine").requestSkipArchive;
let engineState: typeof import("../src/engine").engineState;
let readAll: typeof import("../src/log").readAll;
let renderArchiveLogRows: typeof import("../src/archiverows").renderArchiveLogRows;

let base = "";
let rcloneLog = "";
let eventsLog = "";

function readLog(): string {
  return existsSync(rcloneLog) ? readFileSync(rcloneLog, "utf8") : "";
}
function readEvents(): string {
  return existsSync(eventsLog) ? readFileSync(eventsLog, "utf8") : "";
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
function setScan(entries: string[]): void {
  process.env.RCLONE_STUB_SCAN = entries.join("\n") + "\n";
}
function scanMany(prefixes: string[], count = 1): string[] {
  const out: string[] = [];
  for (const p of prefixes) {
    for (let i = 1; i <= count; i++) out.push(`./${p}/a${i}.zip;300000`);
  }
  return out;
}

/** Max simultaneously active extracts from the stub's START/END events. */
function peakOverlap(text: string): number {
  const events: { t: number; delta: number }[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("START ")) {
      events.push({ t: Number(line.split(" ")[2]), delta: 1 });
    } else if (line.startsWith("END ")) {
      events.push({ t: Number(line.split(" ")[2]), delta: -1 });
    }
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let active = 0;
  let peak = 0;
  for (const e of events) {
    active += e.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "rx-concurrent-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  rcloneLog = join(base, "rclone.log");
  eventsLog = join(base, "events.log");

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const script = `#!/bin/sh
echo "rclone $*" >> "${rcloneLog}"
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  case "$2" in
    *Rclone-Extractor-tmp*) printf './big.bin;300000\\n' ;;
    *) printf '%s' "$RCLONE_STUB_SCAN" ;;
  esac
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '300000 ./big.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  stem=$(basename "$3" .zip)
  echo "RAW $stem"
  echo "START $stem $(date +%s%N)" >> "${eventsLog}"
  sleep "$RCLONE_STUB_SLEEP"
  echo "END $stem $(date +%s%N)" >> "${eventsLog}"
  case ",$RCLONE_STUB_FAIL," in
    *",$stem,"*) echo "extract exploded" >&2; exit 1 ;;
  esac
  exit 0
fi
exit 0
`;
  writeFileSync(join(binDir, "rclone"), script, { mode: 0o755 });
  chmodSync(join(binDir, "rclone"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  setSetting = db.setSetting;
  readAll = (await import("../src/log")).readAll;
  renderArchiveLogRows = (await import("../src/archiverows")).renderArchiveLogRows;
  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  stopEngine = eng.stopEngine;
  forceStopEngine = eng.forceStopEngine;
  requestSkipArchive = eng.requestSkipArchive;
  engineState = eng.engineState;
  await setSetting("scan_root", scanRoot);
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
});

beforeEach(async () => {
  rmSync(rcloneLog, { force: true });
  rmSync(eventsLog, { force: true });
  delete process.env.RCLONE_STUB_FAIL;
  process.env.RCLONE_STUB_SLEEP = "0.12";
  await db!.store.run("DELETE FROM archives");
  await db!.store.run("DELETE FROM runs");
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  await setSetting("concurrency", "1");
  engineState.running = false;
  engineState.jobs = new Map();
  engineState.activeIds = new Set();
});

afterEach(() => {
  engineState.running = false;
  engineState.forceStop = false;
  engineState.stopRequested = false;
});

test("the worker limit is respected and every archive is processed", async () => {
  setScan(scanMany(["g1", "g2", "g3", "g4", "g5", "g6"]));
  await setSetting("concurrency", "3");
  await runEngine();

  const peak = peakOverlap(readEvents());
  expect(peak).toBeLessThanOrEqual(3);
  expect(peak).toBeGreaterThan(1);

  const rows = await db!.store.query<{ status: string }>(
    "SELECT status FROM archives",
  );
  expect(rows.length).toBe(6);
  expect(rows.every((r) => r.status === "done")).toBe(true);

  const run = await db!.store.get1<{ total: number; done: number; failed: number; skipped: number }>(
    "SELECT total, done, failed, skipped FROM runs ORDER BY id DESC LIMIT 1",
  );
  expect({ ...run }).toMatchObject({ total: 6, done: 6, failed: 0, skipped: 0 });
  expect(engineState.done).toBe(6);
  expect(engineState.jobs.size).toBe(6);
  expect([...engineState.jobs.values()].every((j) => j.status === "done")).toBe(true);
}, 20_000);

test("a failure in one job does not stop the other workers", async () => {
  setScan([
    "./g1/failme.zip;300000",
    "./g2/ok2.zip;300000",
    "./g3/ok3.zip;300000",
    "./g4/ok4.zip;300000",
  ]);
  process.env.RCLONE_STUB_FAIL = "failme";
  await setSetting("concurrency", "2");
  await runEngine();

  const rows = await db!.store.query<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives ORDER BY path",
  );
  expect(rows.filter((r) => r.status === "done").length).toBe(3);
  const failed = rows.filter((r) => r.status === "failed");
  expect(failed.length).toBe(1);
  expect(failed[0].error_kind).toBe("extract");

  const run = await db!.store.get1<{ done: number; failed: number; skipped: number }>(
    "SELECT done, failed, skipped FROM runs ORDER BY id DESC LIMIT 1",
  );
  expect({ ...run }).toMatchObject({ done: 3, failed: 1, skipped: 0 });
}, 20_000);

test("log lines stay grouped under each archive's ref_id", async () => {
  setScan([
    "./g1/uniqueA.zip;300000",
    "./g2/uniqueB.zip;300000",
    "./g3/uniqueC.zip;300000",
  ]);
  await setSetting("concurrency", "3");
  await runEngine();

  const rows = await db!.store.query<{ id: number; path: string }>(
    "SELECT id, path FROM archives ORDER BY path",
  );
  expect(rows.length).toBe(3);
  const stemOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.zip$/, "");
  for (const row of rows) {
    const stem = stemOf(row.path);
    const lines = await readAll({ scope: "archive", refId: Number(row.id), kind: "extract" });
    expect(lines.some((l) => l.includes(`RAW ${stem}`))).toBe(true);
    for (const other of rows) {
      if (other.id === row.id) continue;
      expect(lines.some((l) => l.includes(`RAW ${stemOf(other.path)}`))).toBe(false);
    }
  }
}, 20_000);

test("soft stop finishes in-flight jobs and leaves the rest queued", async () => {
  setScan(scanMany(["g1", "g2", "g3", "g4", "g5", "g6"]));
  await setSetting("concurrency", "2");
  process.env.RCLONE_STUB_SLEEP = "1.2";
  const running = runEngine();
  expect(await waitFor(() => engineState.activeIds.size === 2)).toBe(true);
  stopEngine();
  await running;

  const rows = await db!.store.query<{ status: string }>("SELECT status FROM archives");
  expect(rows.filter((r) => r.status === "done").length).toBe(2);
  expect(rows.filter((r) => r.status === "queued").length).toBe(4);

  const run = await db!.store.get1<{ outcome: string; done: number }>(
    "SELECT outcome, done FROM runs ORDER BY id DESC LIMIT 1",
  );
  expect({ ...run }).toMatchObject({ outcome: "interrupted", done: 2 });
  expect(engineState.stage).toBe("interrupted");
}, 20_000);

test("hard stop kills all active processes and requeues every in-flight job", async () => {
  setScan(scanMany(["g1", "g2", "g3", "g4", "g5", "g6"]));
  await setSetting("concurrency", "3");
  process.env.RCLONE_STUB_SLEEP = "1.5";
  const running = runEngine();
  expect(await waitFor(() => engineState.activeIds.size === 3)).toBe(true);
  forceStopEngine();
  await running;

  const rows = await db!.store.query<{ status: string }>("SELECT status FROM archives");
  expect(rows.every((r) => r.status === "queued")).toBe(true);
  const run = await db!.store.get1<{ outcome: string; error_kind: string; done: number }>(
    "SELECT outcome, error_kind, done FROM runs ORDER BY id DESC LIMIT 1",
  );
  expect({ ...run }).toMatchObject({
    outcome: "interrupted",
    error_kind: "interrupted_hard",
    done: 0,
  });
  expect(engineState.activeIds.size).toBe(0);
  expect(engineState.forceStop).toBe(false);
}, 20_000);

test("a targeted skip requeues only the named archive", async () => {
  setScan(scanMany(["g1", "g2", "g3", "g4"]));
  await setSetting("concurrency", "2");
  process.env.RCLONE_STUB_SLEEP = "1.2";
  const running = runEngine();
  expect(await waitFor(() => engineState.activeIds.size === 2)).toBe(true);

  const target = [...engineState.activeIds][0];
  expect(requestSkipArchive(target)).toBe(true);
  await running;

  const rows = await db!.store.query<{ id: number; path: string; status: string }>(
    "SELECT id, path, status FROM archives",
  );
  const requeued = rows.filter((r) => r.status === "queued");
  expect(requeued.length).toBe(1);
  expect(Number(requeued[0].id)).toBe(target);
  expect(rows.filter((r) => r.status === "done").length).toBe(3);
}, 20_000);

test("the group rule holds under load", async () => {
  setScan([
    "./set/pack1.zip;300000",
    "./set/pack2.zip;300000",
    "./set/pack3.zip;300000",
    "./other/pack1.zip;300000",
    "./other/pack2.zip;300000",
  ]);
  await setSetting("concurrency", "4");
  process.env.RCLONE_STUB_SLEEP = "0.12";
  await runEngine();

  const log = readLog();
  // One pre-inspection per group, and the later related archives take the
  // post-extract path instead.
  expect(count(log, "archive list")).toBe(2);
  expect(log).toContain("set/pack1.zip --files-only");
  expect(log).not.toContain("pack2.zip --files-only");
  expect(log).not.toContain("pack3.zip --files-only");
  const tempLists = log.split("\n").filter((l) =>
    /lsf .*Rclone-Extractor-tmp.*pack[23] --recursive/.test(l),
  );
  expect(tempLists.length).toBe(3);

  const rows = await db!.store.query<{ status: string }>("SELECT status FROM archives");
  expect(rows.every((r) => r.status === "done")).toBe(true);
  // Distinct groups ran at the same time.
  expect(peakOverlap(readEvents())).toBeGreaterThan(1);
}, 20_000);

test("concurrency=1 keeps the serial order", async () => {
  setScan(scanMany(["g1", "g2", "g3"]));
  await setSetting("concurrency", "1");
  await runEngine();
  expect(peakOverlap(readEvents())).toBeLessThanOrEqual(1);
  const rows = await db!.store.query<{ status: string }>("SELECT status FROM archives");
  expect(rows.every((r) => r.status === "done")).toBe(true);
}, 20_000);

test("the polled fragment renders active and History cards with Queue IDs", async () => {
  engineState.runId = 1;
  engineState.running = true;
  engineState.stage = "extracting";
  engineState.startedAt = new Date().toISOString();
  engineState.concurrency = 3;
  const mkJob = (
    id: number,
    order: number,
    status: "active" | "done" | "queued",
    phase: string,
  ) => ({
    id,
    rel: `dir${id}/archive${id}.zip`,
    baseName: `archive${id}.zip`,
    order,
    status,
    phase,
    command: "",
    stats:
      status === "active"
        ? {
            bytesDone: 50,
            bytesTotal: 100,
            percent: 50,
            speedBytesPerSec: 10,
            etaText: "5s",
          }
        : null,
    skipArchive: false,
    skipInspection: false,
    groupKey: null,
    startedAt: "",
    finishedAt: "",
  });
  engineState.jobs = new Map([
    [1, mkJob(1, 0, "active", "Extracting")],
    [2, mkJob(2, 1, "done", "")],
    [3, mkJob(3, 2, "queued", "")],
  ]);
  engineState.activeIds = new Set([1]);

  const { dashboard } = await import("../src/routes/dashboard");
  const app = new Hono();
  app.route("/", dashboard);
  const html = await (await app.request("/dashboard/fragment")).text();

  expect(count(html, 'class="card job-card')).toBe(2);
  expect(html).toContain("Concurrency");
  expect(html).toContain("Archives in flight");
  expect(html).toContain("History");
  expect(html).toContain("Queue ID #1");
  expect(html).toContain("Queue ID #2");
  expect(html).toContain("dir1/archive1.zip");
  expect(html).toContain("dir2/archive2.zip");
  expect(html).not.toContain("dir3/archive3.zip");
  expect(html).not.toContain("Upcoming archives");
  expect(html).not.toContain("Current archive");
  expect(html).not.toContain("Active command");
  expect(html).toContain("Extracting");
  expect(html).toContain("aria-valuenow=\"50\"");
  expect(html).toContain("50 B / 100 B");
  expect(html).toContain('hx-vals=\'{"target":"archive","id":"1"}\'');
  expect(html).not.toContain('hx-vals=\'{"target":"archive","id":"2"}\'');
});

test("only the five newest terminal archives appear in History", async () => {
  engineState.runId = 1;
  engineState.running = true;
  engineState.stage = "extracting";
  engineState.startedAt = new Date().toISOString();
  engineState.concurrency = 3;
  const base = Date.parse("2026-11-23T10:00:00.000Z");
  const mkJob = (id: number, order: number, status: "active" | "failed", offset: number) => ({
    id,
    rel: `dir${id}/archive${id}.zip`,
    baseName: `archive${id}.zip`,
    order,
    status,
    phase: "",
    command: "",
    stats: null,
    skipArchive: false,
    skipInspection: false,
    groupKey: null,
    startedAt: "",
    finishedAt: status === "failed" ? new Date(base + offset).toISOString() : "",
  });
  engineState.jobs = new Map([
    [1, mkJob(1, 0, "active", 0)],
    [2, mkJob(2, 1, "failed", 1)],
    [3, mkJob(3, 2, "failed", 2)],
    [4, mkJob(4, 3, "failed", 3)],
    [5, mkJob(5, 4, "failed", 4)],
    [6, mkJob(6, 5, "failed", 5)],
    [7, mkJob(7, 6, "failed", 6)],
  ]);
  engineState.activeIds = new Set([1]);

  const { dashboard } = await import("../src/routes/dashboard");
  const app = new Hono();
  app.route("/", dashboard);
  const html = await (await app.request("/dashboard/fragment")).text();

  expect(count(html, 'class="card job-card')).toBe(6);
  expect(html).toContain("Archives in flight");
  expect(html).toContain("History");
  expect(html).toContain("dir1/archive1.zip");
  expect(html).toContain("Queue ID #1");
  expect(html).toContain("dir3/archive3.zip");
  expect(html).toContain("Queue ID #3");
  expect(html).toContain("dir4/archive4.zip");
  expect(html).toContain("dir7/archive7.zip");
  expect(html).not.toContain("dir2/archive2.zip");
  expect(html).not.toContain("Queue ID #2");
});

test("the archives tab renders live phase and a bar for in-flight rows", async () => {
  const html = renderArchiveLogRows(
    [
      {
        id: 7,
        path: "dir/archive.zip",
        size: 100,
        status: "extracting",
        error_kind: null,
        updated_at: new Date().toISOString(),
      },
    ],
    new Map([
      [
        7,
        {
          phase: "Moving to trash",
          status: "active",
          stats: { bytesDone: 10, bytesTotal: 20, percent: 50, speedBytesPerSec: 1, etaText: "1s" },
        },
      ],
    ]),
  );
  expect(html).toContain("Moving to trash");
  expect(html).toContain('aria-valuenow="50"');
  expect(html).toContain('data-log-toggle="7"');
});

test("a concurrency change mid-run applies only to the next run", async () => {
  setScan(scanMany(["g1", "g2", "g3"]));
  await setSetting("concurrency", "2");
  process.env.RCLONE_STUB_SLEEP = "0.6";
  const running = runEngine();
  expect(await waitFor(() => engineState.activeIds.size === 2)).toBe(true);
  await setSetting("concurrency", "5");
  expect(engineState.concurrency).toBe(2);
  await running;
  expect(engineState.concurrency).toBe(2);
});
