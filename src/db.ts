import { Database } from "bun:sqlite";
import { DB_PATH, APP_PASSWORD } from "./config";

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode=WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archives(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs(
  archive_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  PRIMARY KEY(archive_id, kind)
);
`);

const defaults: Record<string, string> = {
  scan_root: "",
  remote_flags: "",
  queue_max: "500",
  sort_by: "path",
  sort_dir: "asc",
  dry_run: "0",
  trash_subdir: "trash",
  cancel: "0",
  password: APP_PASSWORD,
};

const seed = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)");
for (const [key, value] of Object.entries(defaults)) seed.run(key, value);

export function getSetting(key: string, fallback?: string): string | undefined {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.query(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
