import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-pages-"));
delete process.env.DATABASE_URL;

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
  app = new Hono();
  app.route("/", pages);
});

afterEach(() => {
  engineState.running = false;
  engineState.runId = 0;
  engineState.stage = "idle";
});

test("Progress page renders", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Progress · rclone-extractor</title>");
  expect(body).toContain("Start, stop and watch the current task.");
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
});

test("Logs page renders and lists no runs", async () => {
  const res = await app.request("/logs");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Logs · rclone-extractor</title>");
  expect(body).toContain("Raw output of each run.");
  expect(body).toContain("No runs yet.");
  expect(body).not.toContain("tab=password");
});

test("Errors page renders both sections (failures and password-protected)", async () => {
  const res = await app.request("/errors");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<title>Errors · rclone-extractor</title>");
  expect(body).toContain("Failed archives");
  expect(body).toContain("Password-protected");
  expect(body).toContain("No password-protected archives.");
});
