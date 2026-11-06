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
  close(): Promise<void>;
}

export const SECRET_KEYS = new Set(["rclone_conf", "database_url"]);

export const store: Store = DATABASE_URL
  ? new PostgresStore(DATABASE_URL)
  : new SqliteStore();

const defaults: Record<string, string> = {
  scan_root: "",
  remote_flags: "",
  queue_max: "500",
  sort_by: "path",
  sort_dir: "asc",
  dry_run: "0",
  trash_subdir: "trash",
  cancel: "0",
  resume: "1",
  database_url: DATABASE_URL,
  rclone_conf: "",
  last_run_id: "0",
};

export async function initDb(): Promise<void> {
  await store.init();

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
