export const SQLITE_SCHEMA = `
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

CREATE TABLE IF NOT EXISTS log_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  level TEXT,
  line TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope
  ON log_lines(scope, ref_id, kind, seq);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope_id
  ON log_lines(scope, ref_id, kind, id);
`;

export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archives(
  id BIGSERIAL PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  size BIGINT NOT NULL,
  status TEXT NOT NULL,
  error_kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs(
  id BIGSERIAL PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs(
  archive_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  PRIMARY KEY(archive_id, kind)
);

CREATE TABLE IF NOT EXISTS log_lines(
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  level TEXT,
  line TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope
  ON log_lines(scope, ref_id, kind, seq);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope_id
  ON log_lines(scope, ref_id, kind, id);
`;

/**
 * Convert a `?`-placeholder statement into a Postgres `$n`-placeholder one.
 * Applies only the divergent patterns the app uses (see PG_SCHEMA and the
 * INSERT OR IGNORE / INSERT OR REPLACE rewrites below).
 */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

export function toPgInsert(sql: string): string {
  const s = sql.trim();
  const ignore = /^INSERT\s+OR\s+IGNORE\s+/i;
  const replace = /^INSERT\s+OR\s+REPLACE\s+/i;
  if (ignore.test(s)) {
    return s.replace(ignore, "INSERT ").replace(/;?\s*$/, "") +
      " ON CONFLICT DO NOTHING";
  }
  if (replace.test(s)) {
    const body = s.replace(replace, "INSERT ").replace(/;?\s*$/, "");
    const conflict = /\bINTO\s+(\w+)\s*\(\s*([^)]+?)\s*\)/i.exec(body);
    const table = conflict?.[1]?.toLowerCase();
    if (table === "settings") {
      return `${body} ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    }
    if (table === "archives") {
      return `${body} ON CONFLICT(id) DO UPDATE SET path=excluded.path, size=excluded.size, status=excluded.status, error_kind=excluded.error_kind, created_at=excluded.created_at, updated_at=excluded.updated_at`;
    }
    if (table === "runs") {
      return `${body} ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, finished_at=excluded.finished_at, total=excluded.total, done=excluded.done, failed=excluded.failed, skipped=excluded.skipped`;
    }
    if (table === "logs") {
      return `${body} ON CONFLICT(archive_id, kind) DO UPDATE SET rel_path=excluded.rel_path`;
    }
    return `${body} ON CONFLICT DO NOTHING`;
  }
  return s;
}
