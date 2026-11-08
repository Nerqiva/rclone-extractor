import { store } from "./db";
import { esc } from "./ui";

const DASHES = "-".repeat(72);
const DASH_RE = /^-{40,}$/;

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

function fmtTime(ts: string): string {
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts.slice(11, 19) || ts;
}

export interface RenderedEntry {
  html: string;
  level: string;
}

/**
 * Render raw DB rows into structured HTML log entries.
 * Groups 72-dash blocks into collapsible <details>.
 */
export function renderLogEntries(rows: LogRow[]): RenderedEntry[] {
  const entries: RenderedEntry[] = [];
  let inDetail = false;
  let detailLines: string[] = [];
  let detailIdx = 0;

  for (const row of rows) {
    const time = fmtTime(row.ts);
    const level = row.level || "";
    const line = row.line;

    if (DASH_RE.test(line)) {
      if (!inDetail) {
        inDetail = true;
        detailLines = [];
      } else {
        const id = `log-det-${detailIdx++}`;
        const content = detailLines.map((l) => esc(l)).join("\n");
        entries.push({
          level: "DETAIL",
          html: `<div class="log-entry log-detail"><span class="log-time">${esc(time)}</span><details id="${id}"><summary>Show full output (${detailLines.length} lines)</summary><pre class="log-detail-pre">${content}</pre></details></div>`,
        });
        inDetail = false;
        detailLines = [];
      }
      continue;
    }

    if (inDetail) {
      detailLines.push(line);
      continue;
    }

    const isCmd = line.startsWith("$ ");
    const cls = isCmd ? "log-entry log-cmd" : `log-entry log-${level.toLowerCase() || "info"}`;
    const chip = level
      ? `<span class="log-chip log-chip-${level.toLowerCase()}">${esc(level)}</span>`
      : "";

    const isContinuation = !level && !isCmd && entries.length > 0;
    if (isContinuation) {
      entries.push({
        level: "CONT",
        html: `<div class="log-entry log-continuation"><span class="log-time"></span>${esc(line)}</div>`,
      });
      continue;
    }

    entries.push({
      level: level || "INFO",
      html: `<div class="${cls}"><span class="log-time">${esc(time)}</span>${chip}<span class="log-msg">${esc(line)}</span></div>`,
    });
  }

  if (inDetail && detailLines.length > 0) {
    const content = detailLines.map((l) => esc(l)).join("\n");
    entries.push({
      level: "DETAIL",
      html: `<div class="log-entry log-detail"><span class="log-time"></span><pre class="log-detail-pre">${content}</pre></div>`,
    });
  }

  return entries;
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

/** Same as tail but returns rendered HTML entries for the log viewer. */
export async function tailRendered(
  ref: LogRef,
  limit = 200,
  afterId = 0,
): Promise<{ entries: RenderedEntry[]; lastId: number }> {
  type Row = LogRow & { id: number | string };
  let rows: Row[];
  if (afterId > 0) {
    rows = await store.query<Row>(
      "SELECT id, ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? AND id > ? ORDER BY id ASC LIMIT ?",
      [ref.scope, ref.refId, ref.kind, afterId, limit],
    );
  } else {
    rows = await store.query<Row>(
      "SELECT id, ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY id DESC LIMIT ?",
      [ref.scope, ref.refId, ref.kind, limit],
    );
    rows.reverse();
  }
  const lastId = rows.length ? Number(rows[rows.length - 1].id) : afterId || 0;
  return { entries: renderLogEntries(rows), lastId };
}

export async function readAll(ref: LogRef): Promise<string[]> {
  // Bounded so a pathological log cannot exhaust memory; 50k lines is far
  // beyond any sane archive log and keeps downloads responsive.
  const rows = await store.query<LogRow>(
    "SELECT ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY id ASC LIMIT 50000",
    [ref.scope, ref.refId, ref.kind],
  );
  return rows.map(formatRow);
}
