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
  skipped INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  interrupted_reason TEXT,
  outcome TEXT NOT NULL DEFAULT '',
  error_kind TEXT,
  last_archive TEXT,
  last_command TEXT
);

CREATE TABLE IF NOT EXISTS log_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  level TEXT,
  line TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope_id
  ON log_lines(scope, ref_id, kind, id);

CREATE INDEX IF NOT EXISTS idx_archives_error
  ON archives(error_kind, updated_at DESC)
  WHERE error_kind IS NOT NULL;
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
  skipped INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  interrupted_reason TEXT,
  outcome TEXT NOT NULL DEFAULT '',
  error_kind TEXT,
  last_archive TEXT,
  last_command TEXT
);

CREATE TABLE IF NOT EXISTS log_lines(
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  level TEXT,
  line TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_log_lines_scope_id
  ON log_lines(scope, ref_id, kind, id);

CREATE INDEX IF NOT EXISTS idx_archives_error
  ON archives(error_kind, updated_at DESC)
  WHERE error_kind IS NOT NULL;
`;

/**
 * Split a schema script into individual statements. The bundled schemas
 * contain no semicolons inside string literals, so a plain split is safe.
 */
export function splitSchemaStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True for statements that are safe to skip when they fail on a database
 * whose schema has drifted (e.g. an index over a column dropped by an
 * earlier migration). Tables are never treated as optional.
 */
export function isTolerantSchemaStatement(stmt: string): boolean {
  return /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt);
}

/** Critical tables the app cannot boot without; verified after schema install. */
export const CRITICAL_TABLES = [
  "settings",
  "archives",
  "runs",
  "log_lines",
  "sessions",
] as const;

/** One-line preview of a schema statement for log messages. */
export function schemaStmtPreview(stmt: string): string {
  const oneLine = stmt.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
}

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
      // archives' UNIQUE column is `path` (the id carries no dedup value for
      // conflicting uploads). Keep the original created_at on re-import.
      return `${body} ON CONFLICT(path) DO UPDATE SET size=excluded.size, status=excluded.status, error_kind=excluded.error_kind, updated_at=excluded.updated_at`;
    }
    if (table === "runs") {
      return `${body} ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, finished_at=excluded.finished_at, total=excluded.total, done=excluded.done, failed=excluded.failed, skipped=excluded.skipped, interrupted=excluded.interrupted, interrupted_reason=excluded.interrupted_reason, outcome=excluded.outcome, error_kind=excluded.error_kind, last_archive=excluded.last_archive, last_command=excluded.last_command`;
    }
    return `${body} ON CONFLICT DO NOTHING`;
  }
  return s;
}
