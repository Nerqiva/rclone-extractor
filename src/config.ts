import { mkdirSync } from "node:fs";

export const DATA_DIR = process.env.DATA_DIR ?? "/app/data";
export const DB_PATH = `${DATA_DIR}/app.db`;
export const RCLONE_CONF_PATH = `${DATA_DIR}/rclone.conf`;
export const BIND = process.env.BIND ?? "0.0.0.0";
export const PORT = Number(process.env.PORT ?? 8080);
export const APP_PASSWORD = process.env.APP_PASSWORD ?? ""; // login password (env only)
export const SECRET_KEY = process.env.SECRET_KEY ?? ""; // at-rest encryption passphrase
export const DATABASE_URL = process.env.DATABASE_URL ?? ""; // remote postgres, optional
export const RCLONE_CONF = process.env.RCLONE_CONF ?? ""; // base64-encoded rclone.conf fallback
export const RCLONE_BIN = process.env.RCLONE_BIN ?? "rclone"; // path to the rclone binary

// The local filesystem is only needed for the SQLite database and the
// transient rclone.conf working copy. On hosts with a read-only or
// non-writable disk (and when Postgres is used) none of this is required, so
// directory creation is best-effort and must never crash the process.
export function ensureDataDir(): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
