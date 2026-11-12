import { DATABASE_URL } from "../config";
import { encrypt, decrypt, isEncrypted, encryptionEnabled } from "../crypto";
import { SqliteStore } from "./sqlite";
import { PostgresStore } from "./postgres";

export interface Store {
  backend(): "sqlite" | "postgres";
  init(): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  insertReturningId(sql: string, params?: unknown[]): Promise<number>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get1<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const SECRET_KEYS = new Set(["rclone_conf", "database_url", "rclonex_archive_password"]);

export const store: Store = DATABASE_URL
  ? new PostgresStore(DATABASE_URL)
  : new SqliteStore();

const defaults: Record<string, string> = {
  scan_root: "",
  remote_flags: "",
  queue_max: "500",
  max_archive_size: "0",
  min_archive_size: "0",
  sort_by: "path",
  sort_dir: "asc",
  dry_run: "0",
  trash_subdir: "trash",
  cancel: "0",
  resume: "1",
  database_url: DATABASE_URL,
  rclone_conf: "",
  last_run_id: "0",
  rclonex: "0",
  rclonex_skip_inspection: "1",
  rclonex_continue_on_error: "0",
  rclonex_archive_password_enabled: "0",
  rclonex_archive_password: "",
  rclonex_window_size_enabled: "0",
  rclonex_window_size: "16777216",
  auto_skip_known: "1",
  scan_cache_key: "",
  scan_cache_state: "incomplete",
};

const INIT_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function initDb(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= INIT_ATTEMPTS; attempt++) {
    try {
      await initDbOnce();
      return;
    } catch (e) {
      lastErr = e;
      if (attempt === INIT_ATTEMPTS) break;
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `db init attempt ${attempt}/${INIT_ATTEMPTS} failed: ${String(e)} — retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function initDbOnce(): Promise<void> {
  await store.init();
  await migrateRunsInterrupted();
  await migrateRunsInterruptedReason();
  await migrateRunsOutcome();
  await migrateRunsErrorKind();
  await migrateBackfillRunOutcome();
  await migrateDropLogs();
  await migrateDropLogLinesSeq();
  await migrateDropSessionsCreatedAt();

  const seen = new Set<string>();
  const existing = await store.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings",
  );
  for (const row of existing) seen.add(row.key);

  for (const [key, value] of Object.entries(defaults)) {
    if (seen.has(key)) continue;
    await store.run("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", [
      key,
      value,
    ]);
  }

  await removeLegacyPassword();
  await migratePlaintextSecrets();
}

/**
 * Add the `runs.interrupted` flag (1 = the run was closed by crash recovery,
 * not finished normally). Idempotent; the fresh-install schema in schema.ts
 * already includes the column, so only pre-existing databases hit the ALTER.
 */
async function migrateRunsInterrupted(): Promise<void> {
  try {
    await store.run(
      "ALTER TABLE runs ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0",
    );
    console.log("migrated: added runs.interrupted");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("duplicate") && !msg.includes("already exists")) {
      throw e;
    }
  }
}

/**
 * Add the `runs.interrupted_reason` column: why the run was closed by
 * crash recovery (NULL for runs that finished normally or predate this
 * migration). Idempotent; the fresh-install schema already includes it.
 */
async function migrateRunsInterruptedReason(): Promise<void> {
  try {
    await store.run(
      "ALTER TABLE runs ADD COLUMN interrupted_reason TEXT",
    );
    console.log("migrated: added runs.interrupted_reason");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("duplicate") && !msg.includes("already exists")) {
      throw e;
    }
  }
}

/**
 * Add `runs.outcome`: one of '', finished, interrupted (user stop), killed
 * (host stopped the process: crash, SIGKILL/OOM, SIGTERM/SIGINT deploy), or
 * error (the app itself failed). Idempotent; fresh installs already have it.
 */
async function migrateRunsOutcome(): Promise<void> {
  try {
    await store.run("ALTER TABLE runs ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");
    console.log("migrated: added runs.outcome");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("duplicate") && !msg.includes("already exists")) {
      throw e;
    }
  }
}

/**
 * Add `runs.error_kind`: short app-error code recorded when outcome='error'
 * (no_scan_root, invalid_trash_subdir, invalid_tmp_dir, listing_failed,
 * engine_error). Idempotent; fresh installs already have it.
 */
async function migrateRunsErrorKind(): Promise<void> {
  try {
    await store.run("ALTER TABLE runs ADD COLUMN error_kind TEXT");
    console.log("migrated: added runs.error_kind");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("duplicate") && !msg.includes("already exists")) {
      throw e;
    }
  }
}

/**
 * Backfill outcome for runs closed before the outcome column existed. Every
 * historical interrupted=1 row was a host/process death (SIGTERM at shutdown
 * or crash/kill detected at boot) — never a user stop — so they read as
 * killed. Rows with a finish time and no interrupted flag read as finished.
 */
async function migrateBackfillRunOutcome(): Promise<void> {
  await store.run(
    "UPDATE runs SET outcome='killed' WHERE outcome='' AND interrupted=1",
  );
  await store.run(
    "UPDATE runs SET outcome='finished' WHERE outcome='' AND interrupted=0 AND finished_at IS NOT NULL",
  );
}

/**
 * Drop the `logs` table, superseded by `log_lines` long ago (nothing in the
 * app ever read it; only the backup export round-tripped it).
 */
async function migrateDropLogs(): Promise<void> {
  await store.run("DROP TABLE IF EXISTS logs");
}

/**
 * Drop `log_lines.seq`: nothing read it (only a write-side MAX(seq) fed the
 * old seq allocator, which the restore path no longer uses). Dropping the
 * column also drops its dependent index on Postgres; the explicit DROP INDEX
 * keeps SQLite honest.
 */
async function migrateDropLogLinesSeq(): Promise<void> {
  await store.run("DROP INDEX IF EXISTS idx_log_lines_scope");
  try {
    await store.run("ALTER TABLE log_lines DROP COLUMN seq");
    console.log("migrated: dropped log_lines.seq");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("no such column") && !msg.includes("does not exist")) {
      throw e;
    }
  }
}

/** Drop `sessions.created_at`, which the app never read. */
async function migrateDropSessionsCreatedAt(): Promise<void> {
  try {
    await store.run("ALTER TABLE sessions DROP COLUMN created_at");
    console.log("migrated: dropped sessions.created_at");
  } catch (e) {
    const msg = String(e).toLowerCase();
    if (!msg.includes("no such column") && !msg.includes("does not exist")) {
      throw e;
    }
  }
}

async function removeLegacyPassword(): Promise<void> {
  const legacy = await store.get1<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    ["password"],
  );
  if (!legacy) return;
  await store.run("DELETE FROM settings WHERE key = ?", ["password"]);
  console.warn(
    "removed legacy settings.password; login now uses the APP_PASSWORD environment variable only",
  );
}

async function migratePlaintextSecrets(): Promise<void> {
  const rows = await store.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings",
  );
  if (!encryptionEnabled()) {
    const anySecret = rows.some(
      (r) => SECRET_KEYS.has(r.key) && r.value && !isEncrypted(r.value),
    );
    if (anySecret) {
      console.warn("encryption disabled: secrets stored in plaintext (set SECRET_KEY)");
    }
    return;
  }
  for (const row of rows) {
    if (!SECRET_KEYS.has(row.key)) continue;
    if (!row.value || isEncrypted(row.value)) continue;
    await store.run(
      "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
      [row.key, encrypt(row.value)],
    );
    console.log(`encrypted existing secret: ${row.key}`);
  }
}

export async function getSetting(
  key: string,
  fallback?: string,
): Promise<string | undefined> {
  const row = await store.get1<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  if (!row) return fallback;
  const value = isEncrypted(row.value) ? decrypt(row.value) : row.value;
  return value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const stored = SECRET_KEYS.has(key) ? encrypt(value) : value;
  await store.run(
    "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
    [key, stored],
  );
}

export async function allSettings(): Promise<Record<string, string>> {
  const rows = await store.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings",
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = isEncrypted(r.value) ? (decrypt(r.value) ?? "") : r.value;
  }
  return out;
}
