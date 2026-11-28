import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * Targeted Skip archive posts a numeric id. Under Postgres, Bun SQL returns
 * BIGSERIAL ids as strings, so the queue builder must normalize them or the
 * Map lookup misses and the route reports "Nothing to skip right now."
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-skiptarget-"));
delete process.env.DATABASE_URL;

let db: typeof import("../src/db");
let store: typeof import("../src/db").store;
let setSetting: typeof import("../src/db").setSetting;
let engineState: typeof import("../src/engine").engineState;
let runEngine: typeof import("../src/engine").runEngine;
let configFingerprint: typeof import("../src/engine").configFingerprint;
let app: Hono;

beforeAll(async () => {
  const base = process.env.DATA_DIR!;
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(
    join(binDir, "rclone"),
    `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then printf '40000 ./big.bin\\n'; exit 0; fi
exit 0
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  store = db.store;
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  await setSetting("trash_subdir", "trash");

  const eng = await import("../src/engine");
  engineState = eng.engineState;
  runEngine = eng.runEngine;
  configFingerprint = eng.configFingerprint;

  app = new Hono();
  app.route("/", (await import("../src/routes/dashboard")).dashboard);
  app.route("/", (await import("../src/routes/actions")).actions);
});

afterEach(() => {
  engineState.running = false;
  engineState.stage = "idle";
  engineState.jobs = new Map();
});

function activeJob(id: number) {
  return {
    id,
    rel: `incoming/archive${id}.zip`,
    order: 0,
    status: "active" as const,
    phase: "Extracting",
    command: "",
    stats: null,
    attempt: 0,
    cooldownUntil: 0,
    skipArchive: false,
    skipInspection: false,
    queueSkipped: false,
    groupKey: null,
    finishedAt: "",
  };
}

async function skip(id: number): Promise<string> {
  const form = new FormData();
  form.set("target", "archive");
  form.set("id", String(id));
  const res = await app.request("/run/skip", { method: "POST", body: form });
  expect(res.status).toBe(200);
  return res.headers.get("HX-Trigger") ?? "";
}

test("targeted Skip archive marks the active job and succeeds", async () => {
  const job = activeJob(1);
  engineState.jobs = new Map([[1, job]]);
  engineState.running = true;
  engineState.stage = "extracting";

  const trigger = await skip(1);
  expect(trigger).toContain("Archive skipped");
  expect(job.skipArchive).toBe(true);
});

test("Postgres-style string ids are normalized when the queue is built", async () => {
  const created = new Date().toISOString();
  const id = await store.insertReturningId(
    "INSERT INTO archives(path, size, status, created_at, updated_at) VALUES('pgid/seed.zip', 100000, 'queued', ?, ?)",
    [created, created],
  );
  await setSetting("scan_cache_state", "complete");
  await setSetting("scan_cache_key", configFingerprint(await db.allSettings()));

  const originalQuery = store.query.bind(store);
  store.query = (async (sql: string, params?: unknown[]) => {
    const rows = await originalQuery(sql, params);
    if (/^SELECT id, path, size FROM archives /.test(sql.trim())) {
      return rows.map((r) => ({ ...r, id: String((r as { id: unknown }).id) }));
    }
    return rows;
  }) as typeof store.query;

  try {
    await runEngine();
    expect(engineState.jobs.has(id)).toBe(true);
    const job = engineState.jobs.get(id)!;
    job.status = "active";
    job.phase = "Extracting";
    engineState.running = true;
    engineState.stage = "extracting";

    const trigger = await skip(id);
    expect(trigger).toContain("Archive skipped");
    expect(job.skipArchive).toBe(true);
  } finally {
    store.query = originalQuery as typeof store.query;
  }
});
