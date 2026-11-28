import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * An archive id is reused across runs. Its per-archive log must start clean
 * for the new run: lines from the earlier processing must not reappear in the
 * viewer or the full download. The marker is emitted by the stub's `archive
 * list` so it lands in the raw binary output captured for that archive.
 */
let store: typeof import("../src/db").store;
let setSetting: typeof import("../src/db").setSetting;
let runEngine: typeof import("../src/engine").runEngine;
let app: Hono;
let archiveId = 0;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-rerunlog-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  writeFileSync(
    join(binDir, "rclone"),
    `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then echo './rerun.zip;100000'; exit 0; fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  echo "native marker: $RCLONE_STUB_MARKER"
  exit 1
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then exit 0; fi
exit 0
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const db = await import("../src/db");
  await db.initDb();
  store = db.store;
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");
  await setSetting("min_archive_size", "0");
  await setSetting("max_archive_size", "0");

  runEngine = (await import("../src/engine")).runEngine;
  const { logsapi } = await import("../src/routes/logsapi");
  app = new Hono();
  app.route("/", logsapi);

  process.env.RCLONE_STUB_MARKER = "run-one-marker.bin";
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  await runEngine();

  const row = await store.get1<{ id: number }>(
    "SELECT id FROM archives WHERE path='rerun.zip'",
  );
  if (!row) throw new Error("run 1 did not process rerun.zip");
  archiveId = Number(row.id);

  process.env.RCLONE_STUB_MARKER = "run-two-marker.bin";
  await store.run("UPDATE archives SET status='queued' WHERE id=?", [archiveId]);
  await setSetting("scan_cache_state", "incomplete");
  await setSetting("scan_cache_key", "");
  await runEngine();
});

test("archive log fragment shows only the current run's lines", async () => {
  const res = await app.request(`/logs/archive/${archiveId}/fragment`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("run-two-marker.bin");
  expect(html).not.toContain("run-one-marker.bin");
});

test("full archive download shows only the current run's lines", async () => {
  const res = await app.request(`/download/archive/${archiveId}`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("run-two-marker.bin");
  expect(text).not.toContain("run-one-marker.bin");
});
