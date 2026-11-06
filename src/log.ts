import { store } from "./db";

const DASHES = "-".repeat(72);

export type LogScope = "run" | "archive";
export type LogKind = "main" | "errors" | "rclone" | "extract";

/** Maximum lines rendered in the log views; both initial paint and polling. */
export const LOG_TAIL_LIMIT = 300;

export interface LogRef {
  scope: LogScope;
  refId: number;
  kind: LogKind;
}

interface LogRow {
  ts: string;
  level: string | null;
  line: string;
}

function formatRow(row: LogRow): string {
  return `${row.ts}${row.level ? ` ${row.level}` : ""} ${row.line}`.trimEnd();
}

export class Logger {
  private seq = 0;

  constructor(private ref: LogRef) {}

  info(msg: string): void {
    void this.write("INFO", msg);
  }

  warn(msg: string): void {
    void this.write("WARN", msg);
  }

  error(msg: string, detail?: string): void {
    const body = detail !== undefined ? `${DASHES}\n${detail}\n${DASHES}` : msg;
    void this.write("ERROR", detail !== undefined ? `${msg}\n${body}` : msg);
  }

  private async write(level: string, line: string): Promise<void> {
    const ts = new Date().toISOString();
    try {
      await store.run(
        "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [this.ref.scope, this.ref.refId, this.ref.kind, this.seq++, ts, level, line],
      );
    } catch (e) {
      console.error("log write failed:", String(e));
    }
  }
}

export interface TailResult {
  lines: string[];
  lastId: number;
}

/**
 * Last `limit` lines formatted as strings. When `afterId` is > 0 only lines
 * newer than that id are returned, which is what the live log view polls.
 */
export async function tail(
  ref: LogRef,
  limit = 200,
  afterId = 0,
): Promise<TailResult> {
  type Row = LogRow & { id: number | string };
  if (afterId > 0) {
    const rows = await store.query<Row>(
      "SELECT id, ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? AND id > ? ORDER BY id ASC LIMIT ?",
      [ref.scope, ref.refId, ref.kind, afterId, limit],
    );
    return {
      lines: rows.map(formatRow),
      lastId: rows.length ? Number(rows[rows.length - 1].id) : afterId,
    };
  }
  const rows = await store.query<Row>(
    "SELECT id, ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY id DESC LIMIT ?",
    [ref.scope, ref.refId, ref.kind, limit],
  );
  rows.reverse();
  return {
    lines: rows.map(formatRow),
    lastId: rows.length ? Number(rows[rows.length - 1].id) : 0,
  };
}

export async function readAll(ref: LogRef): Promise<string[]> {
  const rows = await store.query<LogRow>(
    "SELECT ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY id ASC",
    [ref.scope, ref.refId, ref.kind],
  );
  return rows.map(formatRow);
}
