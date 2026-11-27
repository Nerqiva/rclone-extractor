import { mkdirSync } from "node:fs";

export const DATA_DIR = process.env.DATA_DIR ?? "/app/data";
export const DB_PATH = `${DATA_DIR}/app.db`;
// Every rclone invocation unconditionally gets `--config <effective path>`.
// (A stored/env rclone_conf, when set, is written to the primary path as a
// working copy. See Rclone.fromSettings. When the primary path is not
// writable for any reason, the working copy goes to the /tmp fallback
// instead; see RCLONE_CONF_FALLBACK_PATH.)
export const RCLONE_CONF_PATH = `${DATA_DIR}/rclone.conf`;
export const RCLONE_CONF_FALLBACK_DIR = "/tmp/app/data";
export const RCLONE_CONF_FALLBACK_PATH = `${RCLONE_CONF_FALLBACK_DIR}/rclone.conf`;
export const BIND = process.env.BIND ?? "0.0.0.0";
export const PORT = Number(process.env.PORT ?? 8080);
// Process lifetime starts here; the Configuration page shows this timestamp.
export const BOOT_AT = new Date();
export const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
export const SECRET_KEY = process.env.SECRET_KEY ?? "";
export const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const RCLONE_CONF = process.env.RCLONE_CONF ?? "";
export const RCLONE_BIN = process.env.RCLONE_BIN ?? "rclone";
export const RCLONEX_BIN = process.env.RCLONEX_BIN ?? "rclonex";
// Max connections this app opens to Postgres. Keep it small: the remote
// service caps total connections and reserves slots for superusers.
const pgPoolMax = Number(process.env.PG_POOL_MAX ?? 4);
export const PG_POOL_MAX =
  Number.isFinite(pgPoolMax) && pgPoolMax >= 1 ? Math.min(Math.floor(pgPoolMax), 32) : 4;
export const TRUST_PROXY = process.env.TRUST_PROXY === "1";
export const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";
const validZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

// Default to the host zone so every displayed timestamp follows the machine's
// clock; APP_TZ stays as an explicit override for hosts with a different UI zone.
const HOST_TZ = (() => {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected && validZone(detected) ? detected : "UTC";
})();
export const APP_TZ = (() => {
  const raw = (process.env.APP_TZ ?? "").trim() || HOST_TZ;
  if (validZone(raw)) return raw;
  console.warn(`invalid APP_TZ "${raw}"; falling back to ${HOST_TZ}`);
  return HOST_TZ;
})();

// The local filesystem is only needed for the SQLite database and the
// transient rclone.conf working copy (which falls back to /tmp/app/data when
// DATA_DIR is not writable). On hosts with a read-only or non-writable disk
// (and when Postgres is used) none of this is required, so directory
// creation is best-effort and must never crash the process.
export function ensureDataDir(): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}
