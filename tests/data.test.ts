import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Backup export/import round-trip coverage. Runs against an isolated
// DATA_DIR like the other integration tests.
let db: typeof import("../src/db");
let app: import("hono").Hono;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-data-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  db = await import("../src/db");
  await db.initDb();

  const { Hono } = await import("hono");
  const { data } = await import("../src/routes/data");
  app = new Hono();
  app.route("/", data);
});

async function jsonRequest(path: string, form: FormData): Promise<Response> {
  return app.request(path, { method: "POST", body: form });
}

async function exportBackup(includeSecrets = false): Promise<any> {
  const form = new FormData();
  if (includeSecrets) form.append("include_rclone", "1");
  const res = await jsonRequest("/export", form);
  expect(res.status).toBe(200);
  return res.json();
}

test("export -> wipe -> import restores rows with the same ids", async () => {
  const ts = new Date().toISOString();
  await db.store.run(
    "INSERT INTO archives(id, path, size, status, error_kind, created_at, updated_at) VALUES(?, ?, ?, 'done', NULL, ?, ?)",
    [101, "backup-test/a.zip", 123, ts, ts],
  );
  await db.store.run(
    "INSERT INTO runs(id, started_at, finished_at, total, done, failed, skipped, interrupted) VALUES(?, ?, ?, 1, 1, 0, 0, 0)",
    [102, ts, ts],
  );
  await db.store.run(
    "INSERT INTO log_lines(scope, ref_id, kind, ts, level, line) VALUES('archive', 101, 'extract', ?, 'INFO', 'hello')",
    [ts],
  );

  const backup = await exportBackup();
  expect(backup.archives.some((a: any) => a.id === 101)).toBe(true);
  expect(backup.runs.some((r: any) => r.id === 102)).toBe(true);
  expect(backup.logs).toBeUndefined();
  expect(backup.log_lines.some((l: any) => l.ref_id === 101)).toBe(true);

  // Wipe everything and restore from the backup.
  await db.store.run("DELETE FROM log_lines");
  await db.store.run("DELETE FROM runs");
  await db.store.run("DELETE FROM archives");

  const form = new FormData();
  form.append("archive", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
  const res = await jsonRequest("/import", form);
  const body = (await res.json()) as { ok: boolean; message?: string };
  expect(body.ok).toBe(true);

  const archive = await db.store.get1<{ id: number; path: string }>(
    "SELECT id, path FROM archives WHERE id = 101",
  );
  expect(archive?.path).toBe("backup-test/a.zip");
  const run = await db.store.get1<{ id: number }>("SELECT id FROM runs WHERE id = 102");
  expect(run?.id).toBe(102);
  const lines = await db.store.query<{ line: string }>(
    "SELECT line FROM log_lines WHERE scope = 'archive' AND ref_id = 101",
  );
  expect(lines.length).toBe(1);
  expect(lines[0].line).toBe("hello");
});

test("re-importing the same backup does not duplicate log_lines", async () => {
  const backup = await exportBackup();
  const form = new FormData();
  form.append("archive", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
  const res = await jsonRequest("/import", form);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  const lines = await db.store.query<{ line: string }>(
    "SELECT line FROM log_lines WHERE scope = 'archive' AND ref_id = 101",
  );
  expect(lines.length).toBe(1);
});

test("importing a secret-less backup does not wipe stored rclone_conf", async () => {
  await db.setSetting("rclone_conf", "UEVyLfM8c="); // any value; encrypted at rest
  const backup = await exportBackup(false); // secrets blanked
  expect(backup.settings.rclone_conf).toBe("");

  await db.setSetting("rclone_conf", "UEVyLfM8b="); // sentinel: set to a second value
  const form = new FormData();
  form.append("archive", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
  const res = await jsonRequest("/import", form);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  expect(await db.getSetting("rclone_conf")).toBe("UEVyLfM8b=");
});

test("backups written by older versions (with logs and seq) still import", async () => {
  const backup = await exportBackup();
  // Simulate a pre-cleanup backup: logs table dump + seq on log lines.
  const legacy = {
    ...backup,
    logs: [{ archive_id: 101, kind: "extract", rel_path: "archive-101-extract.log" }],
    log_lines: backup.log_lines.map((l: any) => ({ ...l, seq: 0 })),
  };
  const form = new FormData();
  form.append("archive", new File([JSON.stringify(legacy)], "backup.json", { type: "application/json" }));
  const res = await jsonRequest("/import", form);
  const body = (await res.json()) as { ok: boolean; message?: string };
  expect(body.ok).toBe(true);
});

test("malformed records are rejected before anything is written", async () => {
  const backup = { version: 1, archives: [{ id: "nope", path: "x.zip" }] };
  const form = new FormData();
  form.append("archive", new File([JSON.stringify(backup)], "backup.json", { type: "application/json" }));
  const res = await jsonRequest("/import", form);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});
