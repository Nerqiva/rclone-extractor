import { Hono } from "hono";
import { store, allSettings, SECRET_KEYS } from "../db";
import { encryptionEnabled, encrypt } from "../crypto";
import { engineState } from "../engine";
import { LOG_EXPORT_LIMIT } from "../log";
import { isSafeRel } from "../archive";

export const data = new Hono();

const MAX_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB of JSON is already absurd
const LOG_LINES_PER_ARCHIVE_IMPORT_LIMIT = 100_000;
const IMPORT_ARRAY_LIMIT = 100_000;

data.post("/export", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const includeSecrets = form?.get("include_rclone") != null;

  const settings = await allSettings();
  // Deterministic ORDER BY id so a restore replays in stable order.
  const logLines = await store.query(
    "SELECT * FROM log_lines ORDER BY id LIMIT ?",
    [LOG_EXPORT_LIMIT],
  );
  const payload: Record<string, unknown> = {
    version: 1,
    exported_at: new Date().toISOString(),
    settings: includeSecrets ? settings : omitSecrets(settings),
    archives: await store.query("SELECT * FROM archives ORDER BY id"),
    runs: await store.query("SELECT * FROM runs ORDER BY id"),
    log_lines: logLines,
    log_lines_truncated: logLines.length >= LOG_EXPORT_LIMIT,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename=export-${Date.now()}.json`,
    },
  });
});

function omitSecrets(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) {
    out[k] = SECRET_KEYS.has(k) ? "" : v;
  }
  return out;
}

type RawRecord = Record<string, unknown>;

function asDateStr(v: unknown, max = 64): string | null {
  const s = asStr(v, max);
  if (!s) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

function asInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function asStr(v: unknown, max = 10_000): string | null {
  if (typeof v !== "string") return null;
  return v.length <= max ? v : null;
}

function asOptStr(v: unknown, max = 10_000): string | null | undefined {
  if (v === null || v === undefined) return null;
  const s = asStr(v, max);
  return s === null ? undefined : s;
}

interface ValidatedArchive {
  id: number;
  path: string;
  size: number;
  status: string;
  error_kind: string | null;
  created_at: string;
  updated_at: string;
  last_run_id: number | null;
}

interface ValidatedRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  interrupted: number;
  interrupted_reason: string | null;
  outcome: string;
  error_kind: string | null;
  last_archive: string | null;
  last_command: string | null;
  last_touch_at: string | null;
}

interface ValidatedLogLine {
  scope: "run" | "archive";
  ref_id: number;
  kind: string;
  ts: string;
  level: string | null;
  line: string;
}

function validateArchives(raw: unknown): ValidatedArchive[] | string {
  if (!Array.isArray(raw)) return "archives must be an array";
  if (raw.length > IMPORT_ARRAY_LIMIT) return `archives exceeds ${IMPORT_ARRAY_LIMIT} rows`;
  const out: ValidatedArchive[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as RawRecord;
    if (!a || typeof a !== "object") return `archives[${i}] is not an object`;
    const id = asInt(a.id);
    const size = Number(a.size);
    const path = asStr(a.path, 4096);
    const status = asStr(a.status, 64);
    if (id === null || id < 0) return `archives[${i}].id is not a non-negative integer`;
    if (!path) return `archives[${i}].path is missing or too long`;
    // Paths join onto scan_root (or resolve against the local filesystem);
    // a hostile backup must not smuggle an outside-the-root entry in.
    if (!isSafeRel(path)) return `archives[${i}].path is not a safe relative path`;
    if (!Number.isFinite(size) || size < 0) return `archives[${i}].size is not a non-negative number`;
    if (!status) return `archives[${i}].status is missing`;
    const error_kind = asOptStr(a.error_kind, 64);
    if (error_kind === undefined) return `archives[${i}].error_kind is not a string`;
    const created_at = asDateStr(a.created_at) ?? new Date().toISOString();
    const updated_at = asDateStr(a.updated_at) ?? new Date().toISOString();
    // last_run_id links the row to its run for the Archives tab; older
    // backups predate the column and import with null.
    const lastRunIdRaw = a.last_run_id;
    const last_run_id =
      lastRunIdRaw === null || lastRunIdRaw === undefined ? null : asInt(lastRunIdRaw);
    if (last_run_id === undefined || (last_run_id !== null && last_run_id < 0)) {
      return `archives[${i}].last_run_id is not a non-negative integer`;
    }
    out.push({ id, path, size: Math.trunc(size), status, error_kind, created_at, updated_at, last_run_id });
  }
  return out;
}

function validateRuns(raw: unknown): ValidatedRun[] | string {
  if (!Array.isArray(raw)) return "runs must be an array";
  if (raw.length > IMPORT_ARRAY_LIMIT) return `runs exceeds ${IMPORT_ARRAY_LIMIT} rows`;
  const out: ValidatedRun[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as RawRecord;
    if (!r || typeof r !== "object") return `runs[${i}] is not an object`;
    const id = asInt(r.id);
    const started_at = asStr(r.started_at, 64);
    if (id === null || id < 0) return `runs[${i}].id is not a non-negative integer`;
    if (!started_at) return `runs[${i}].started_at is missing`;
    const finished_at = asOptStr(r.finished_at, 64);
    if (finished_at === undefined) return `runs[${i}].finished_at is not a string`;
    const total = asInt(r.total ?? 0) ?? 0;
    const done = asInt(r.done ?? 0) ?? 0;
    const failed = asInt(r.failed ?? 0) ?? 0;
    const skipped = asInt(r.skipped ?? 0) ?? 0;
    const interrupted = asInt(r.interrupted ?? 0) ?? 0;
    // Backups written before interrupted_reason existed import with null.
    const interrupted_reason = asOptStr(r.interrupted_reason, 500);
    if (interrupted_reason === undefined) {
      return `runs[${i}].interrupted_reason is not a string`;
    }
    // Backups written before outcome/error_kind existed import as empty.
    const outcome = asOptStr(r.outcome, 32) ?? "";
    if (outcome === undefined) {
      return `runs[${i}].outcome is not a string`;
    }
    const outcomeValue = ["", "finished", "interrupted", "killed", "error"].includes(outcome)
      ? outcome
      : "";
    const error_kind = asOptStr(r.error_kind, 64);
    if (error_kind === undefined) {
      return `runs[${i}].error_kind is not a string`;
    }
    // Backups written before last_* existed import with null.
    const last_archive = asOptStr(r.last_archive, 4096);
    if (last_archive === undefined) {
      return `runs[${i}].last_archive is not a string`;
    }
    const last_command = asOptStr(r.last_command, 8192);
    if (last_command === undefined) {
      return `runs[${i}].last_command is not a string`;
    }
    // last_touch_at heartbeat: old backups predate it; import with null.
    const last_touch_at = asOptStr(r.last_touch_at, 64);
    if (last_touch_at === undefined) {
      return `runs[${i}].last_touch_at is not a string`;
    }
    out.push({ id, started_at, finished_at, total, done, failed, skipped, interrupted, interrupted_reason, outcome: outcomeValue, error_kind, last_archive, last_command, last_touch_at });
  }
  return out;
}

function validateLogLines(raw: unknown): ValidatedLogLine[] | string {
  if (!Array.isArray(raw)) return "log_lines must be an array";
  if (raw.length > LOG_LINES_PER_ARCHIVE_IMPORT_LIMIT) {
    return `log_lines exceeds ${LOG_LINES_PER_ARCHIVE_IMPORT_LIMIT} rows`;
  }
  const out: ValidatedLogLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i] as RawRecord;
    if (!l || typeof l !== "object") return `log_lines[${i}] is not an object`;
    const scope = l.scope === "run" || l.scope === "archive" ? l.scope : null;
    if (!scope) return `log_lines[${i}].scope must be "run" or "archive"`;
    const ref_id = asInt(l.ref_id);
    const kind = asStr(l.kind, 32);
    if (ref_id === null || ref_id < 0) return `log_lines[${i}].ref_id is not a non-negative integer`;
    if (!kind) return `log_lines[${i}].kind is missing`;
    const ts = asStr(l.ts, 64) ?? new Date().toISOString();
    const level = asOptStr(l.level, 16);
    if (level === undefined) return `log_lines[${i}].level is not a string`;
    const line = asStr(l.line, 100_000) ?? "";
    out.push({ scope, ref_id, kind, ts, level, line });
  }
  return out;
}

data.post("/import", async (c) => {
  // The Configuration page disables Import while a task is running; enforce
  // the same server-side since import replaces data wholesale.
  if (engineState.running) {
    return c.json({ ok: false, message: "Task is running — stop it first." }, 409);
  }
  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return c.json({ ok: false, message: "invalid multipart form" }, 400);
  }
  const file = form.get("archive");
  if (!(file instanceof File)) {
    return c.json({ ok: false, message: "no archive uploaded" }, 400);
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return c.json({ ok: false, message: "backup is too large (50 MB max)" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return c.json({ ok: false, message: `invalid JSON: ${String(e)}` }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return c.json({ ok: false, message: "invalid backup: expected a JSON object" }, 400);
  }
  const backup = parsed as Record<string, unknown>;

  // Validate everything before touching the database, so a malformed
  // backup can never leave a half-applied import behind.
  const archives = backup.archives === undefined ? [] : validateArchives(backup.archives);
  if (typeof archives === "string") return c.json({ ok: false, message: archives }, 400);
  const runs = backup.runs === undefined ? [] : validateRuns(backup.runs);
  if (typeof runs === "string") return c.json({ ok: false, message: runs }, 400);
  const logLines = backup.log_lines === undefined ? [] : validateLogLines(backup.log_lines);
  if (typeof logLines === "string") return c.json({ ok: false, message: logLines }, 400);
  // Backups from before the `logs` table was dropped may carry a `logs`
  // array; it is accepted and ignored (nothing ever read it).

  const settings = backup.settings as Record<string, unknown> | undefined;

  const counts: string[] = [];
  try {
    await store.transaction(async (tx) => {
      if (settings && typeof settings === "object") {
        for (const [k, v] of Object.entries(settings)) {
          if (k === "password") continue; // legacy setting; login uses APP_PASSWORD only
          if (typeof v !== "string") continue;
          // A non-secret export blanks secret values; importing one must not
          // wipe the stored credentials.
          if (v === "" && SECRET_KEYS.has(k)) continue;
          const stored = SECRET_KEYS.has(k) ? encrypt(v) : v;
          await tx.run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", [k, stored]);
        }
        counts.push("settings");
      }

      // Archives: drop rows replaced or shadowed by the backup (same id or
      // same path with a different id), then insert cleanly.
      for (const a of archives) {
        const conflicts = await tx.query<{ id: number }>(
          "SELECT id FROM archives WHERE id = ? OR path = ?",
          [a.id, a.path],
        );
        const conflictIds = conflicts.map((r) => Number(r.id)).filter((n) => n !== a.id);
        if (conflictIds.length > 0) {
          const ph = conflictIds.map(() => "?").join(", ");
          await tx.run(
            `DELETE FROM log_lines WHERE scope = 'archive' AND ref_id IN (${ph})`,
            conflictIds,
          );
          await tx.run(`DELETE FROM archives WHERE id IN (${ph})`, conflictIds);
        }
        // The backup row itself may collide on either unique key with a row
        // that shares its id (same backup re-imported) — delete then insert.
        await tx.run("DELETE FROM log_lines WHERE scope = 'archive' AND ref_id = ?", [a.id]);
        await tx.run("DELETE FROM archives WHERE id = ? OR path = ?", [a.id, a.path]);
        await tx.run(
          "INSERT INTO archives(id, path, size, status, error_kind, created_at, updated_at, last_run_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
          [a.id, a.path, a.size, a.status, a.error_kind, a.created_at, a.updated_at, a.last_run_id],
        );
      }
      if (archives.length > 0) counts.push(`${archives.length} archives`);

      for (const r of runs) {
        await tx.run("DELETE FROM log_lines WHERE scope = 'run' AND ref_id = ?", [r.id]);
        await tx.run("DELETE FROM runs WHERE id = ?", [r.id]);
        await tx.run(
          "INSERT INTO runs(id, started_at, finished_at, total, done, failed, skipped, interrupted, interrupted_reason, outcome, error_kind, last_archive, last_command, last_touch_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [r.id, r.started_at, r.finished_at, r.total, r.done, r.failed, r.skipped, r.interrupted, r.interrupted_reason, r.outcome, r.error_kind, r.last_archive, r.last_command, r.last_touch_at],
        );
      }
      if (runs.length > 0) counts.push(`${runs.length} runs`);

      for (const l of logLines) {
        await tx.run(
          "INSERT INTO log_lines(scope, ref_id, kind, ts, level, line) VALUES(?, ?, ?, ?, ?, ?)",
          [l.scope, l.ref_id, l.kind, l.ts, l.level, l.line],
        );
      }
      if (logLines.length > 0) counts.push(`${logLines.length} log lines`);

      // Bring the Postgres sequences past the explicitly inserted ids, or
      // the next engine INSERT collides with a restored row.
      if (tx.backend() === "postgres") {
        for (const table of ["archives", "runs", "log_lines"] as const) {
          await tx.run(
            `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`,
          );
        }
      }
    });
  } catch (e) {
    return c.json({ ok: false, message: `import failed: ${String(e)}` }, 500);
  }

  const enc = encryptionEnabled()
    ? "Secrets re-encrypted with the current key."
    : "Encryption off: secrets stored in plaintext.";
  return c.json({
    ok: true,
    message: `Imported ${counts.join(", ") || "nothing"}. ${enc}`,
  });
});
