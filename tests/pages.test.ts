import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-pages-"));
delete process.env.DATABASE_URL;

const VERSION = readFileSync(join(import.meta.dir, "..", "VERSION"), "utf8").trim();

function divBlock(html: string, id: string): string {
  const start = html.indexOf(`<div id="${id}"`);
  if (start < 0) throw new Error(`missing #${id}`);
  let depth = 0;
  for (const match of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    if (match[0] === "</div>") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, start + (match.index ?? 0) + match[0].length);
      }
    } else {
      depth += 1;
    }
  }
  throw new Error(`unclosed #${id}`);
}

// Mock rclone so the Configuration page's binary probe (checkRclone) has
// something to talk to.
const binDir = join(process.env.DATA_DIR, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(
  join(binDir, "rclone"),
  "#!/bin/sh\necho 'rclone v0.0.0-test'\n",
  { mode: 0o755 },
);
process.env.PATH = `${binDir}:${process.env.PATH}`;

let app: Hono;
let engineState: typeof import("../src/engine").engineState;

beforeAll(async () => {
  const db = await import("../src/db");
  await db.initDb();
  engineState = (await import("../src/engine")).engineState;
  const { pages } = await import("../src/routes/pages");
  const { logsapi } = await import("../src/routes/logsapi");
  app = new Hono();
  app.route("/", pages);
  app.route("/", logsapi);
});

afterEach(() => {
  engineState.running = false;
  engineState.runId = 0;
  engineState.stage = "idle";
  engineState.jobs = new Map();
  engineState.activeIds = new Set();
});

test("Progress page renders", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Progress · rclone-extractor</title>");
  expect(body).toContain("Start, stop and watch the current task.");
  expect(body).toContain('Show Queue (0)');
  expect(body).toContain('id="queuePanel"');
  expect(body).toContain('id="queuePanelBody"');
  const panel = divBlock(body, "dashboard-panel");
  expect(panel).toContain('hx-get="/dashboard/fragment"');
  expect(panel).toContain('hx-swap="morphdom"');
  expect(panel).not.toContain('id="queuePanel"');
  expect(body.slice(body.indexOf(panel) + panel.length)).toContain('id="queuePanel"');
  expect(body).not.toContain("Current archive");
  expect(body).not.toContain("Active command");
  expect(body).not.toContain("Upcoming archives");
});

test("the queue toggle counts queued archives", async () => {
  engineState.jobs = new Map([
    [
      5,
      {
        id: 5,
        rel: "incoming/a.zip",
        order: 0,
        status: "queued" as const,
        phase: "",
        command: "",
        stats: null,
        skipArchive: false,
        skipInspection: false, queueSkipped: false,
        groupKey: null,
        finishedAt: "",
      },
    ],
  ]);
  const res = await app.request("/");
  expect(await res.text()).toContain("Show Queue (1)");
});

test("Configuration page renders the sectioned plain-English form", async () => {
  const res = await app.request("/config");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Configuration · rclone-extractor</title>");
  expect(body).toContain("Settings, secrets, backup and maintenance.");
  for (const section of ["Connection", "Selection", "Extract", "Behaviour", "RcloneX", "Advanced"]) {
    expect(body).toContain(section);
  }
  expect(body).toContain("Scan root");
  expect(body).toContain("scan_root"); // stored key stays visible
  expect(body).toMatch(/name="concurrency"[^>]*step="1"/);
  expect(body).toContain("App version");
  expect(body).toContain(`<code>${VERSION}</code>`);
  expect(body).toContain("Booted at");
});

test("Configuration page stays editable while a task runs", async () => {
  engineState.running = true;
  const res = await app.request("/config");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('id="config-form"');
  expect(body).toContain("changes apply from the next run");
  // The destructive maintenance actions and the backup import stay disabled,
  // but Clear queues remains available.
  expect(body).toContain("Clear queues");
  engineState.running = false;
});

test("Logs page renders and lists no runs", async () => {
  const res = await app.request("/logs");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Logs · rclone-extractor</title>");
  expect(body).toContain("Raw output of each run.");
  expect(body).toContain("No runs yet.");
  expect(body).not.toContain("tab=password");
  expect(body).not.toContain("tab=errors");
  expect(body).not.toContain(">Errors</a>");
  expect(body).toContain(">Run log</a>");
  expect(body).toContain(">Archives</a>");
});

test("run log polling and download work without the removed kind query", async () => {
  const db = await import("../src/db");
  const { insertLogLines } = await import("../src/log");
  const runId = await db.store.insertReturningId(
    "INSERT INTO runs(started_at, total) VALUES(?, 0)",
    [new Date().toISOString()],
  );
  await insertLogLines(
    { scope: "run", refId: runId, kind: "main" },
    ["hello from the run log"],
  );
  const fragment = await app.request(`/logs/fragment?run=${runId}`);
  expect(fragment.status).toBe(200);
  const data = (await fragment.json()) as { runId: number; entries: string[] };
  expect(data.runId).toBe(runId);
  expect(data.entries.join("")).toContain("hello from the run log");
  const download = await app.request(`/download/run/${runId}?kind=main`);
  expect(download.status).toBe(200);
  expect(await download.text()).toContain("hello from the run log");
});

test("Logs page offers a live-preview toggle for a running session", async () => {
  const db = await import("../src/db");
  const runId = await db.store.insertReturningId(
    "INSERT INTO runs(started_at, total) VALUES(?, 0)",
    [new Date().toISOString()],
  );
  engineState.running = true;
  engineState.runId = runId;
  const res = await app.request(`/logs?run=${runId}`);
  const body = await res.text();
  expect(body).toContain('id="logViewer"');
  expect(body).not.toContain("data-kind=");
  expect(body).toContain('data-live="1"');
  expect(body).toContain('data-live-toggle="log"');
  expect(body).toContain("Live preview");
});

test("Errors page offers a live-preview toggle while a task runs", async () => {
  engineState.running = true;
  engineState.runId = 1;
  const res = await app.request("/errors");
  const body = await res.text();
  expect(body).toContain('id="errorCards"');
  expect(body).toContain('data-live="1"');
  expect(body).toContain('data-live-toggle="errors"');
});

test("Errors page renders failures and one Skipped section", async () => {
  const res = await app.request("/errors");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Errors · rclone-extractor</title>");
  expect(body).toContain("Failed archives");
  expect(body).toContain("Skipped archives");
  expect(body).toContain("No password-protected archives.");
});
