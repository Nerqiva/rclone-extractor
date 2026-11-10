import { store } from "./db";
import { esc } from "./ui";

const DASHES = "-".repeat(72);
const DASH_RE = /^-{40,}$/;

export type LogScope = "run" | "archive";
export type LogKind = "main" | "errors" | "extract";

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

// Detail ids must be unique across the initial render and every live poll
// (each render restarts its local counter), so use one process-wide counter.
let detailIdSeq = 0;

/**
 * Render raw DB rows into structured HTML log entries.
 * Groups 72-dash blocks into collapsible <details>.
 */
export function renderLogEntries(rows: LogRow[]): RenderedEntry[] {
  const entries: RenderedEntry[] = [];
  let inDetail = false;
  let detailLines: string[] = [];

  for (const row of rows) {
    const time = fmtTime(row.ts);
    const level = row.level || "";
    const line = row.line;

    if (DASH_RE.test(line)) {
      if (!inDetail) {
        inDetail = true;
        detailLines = [];
      } else {
        const id = `log-det-${detailIdSeq++}`;
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
  // Writes are serialized through this chain so the order they hit the
  // database matches call order. With a Postgres pool, concurrent inserts
  // can otherwise land out of order and polls cursoring on `id` permanently
  // skip lines.
  private chain: Promise<void> = Promise.resolve();
  private static pending = new Set<Promise<void>>();

  constructor(private ref: LogRef) {}

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string, detail?: string): void {
    const body = detail !== undefined ? `${DASHES}\n${detail}\n${DASHES}` : msg;
    this.write("ERROR", detail !== undefined ? `${msg}\n${body}` : msg);
  }

  /** Resolves once every write queued so far has landed (or failed). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Flush every live Logger; call before closing the database on shutdown. */
  static async flushAll(): Promise<void> {
    await Promise.allSettled([...Logger.pending]);
  }

  private write(level: string, line: string): void {
    const ts = new Date().toISOString();
    const insert = this.chain.then(async () => {
      try {
        await store.run(
          "INSERT INTO log_lines(scope, ref_id, kind, ts, level, line) VALUES(?, ?, ?, ?, ?, ?)",
          [this.ref.scope, this.ref.refId, this.ref.kind, ts, level, line],
        );
      } catch (e) {
        console.error("log write failed:", String(e));
      }
    });
    this.chain = insert;
    Logger.pending.add(insert);
    void insert.finally(() => Logger.pending.delete(insert));
  }
}

/**
 * Last `limit` lines rendered as HTML entries. When `afterId` is > 0 only
 * lines newer than that id are returned, which is what the live log view
 * polls. Rows come back in `id` order; callers cursor on `lastId`.
 */
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

/** Insert raw lines. Used for diagnostics with no app wording. */
export async function appendRawLines(ref: LogRef, lines: string[]): Promise<void> {
  await insertLogLines(ref, lines);
}

/** Insert log lines in one transaction. */
export async function insertLogLines(
  ref: LogRef,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const ts = new Date().toISOString();
  await store.transaction(async (tx) => {
    for (const line of lines) {
      await tx.run(
        "INSERT INTO log_lines(scope, ref_id, kind, ts, level, line) VALUES(?, ?, ?, ?, ?, ?)",
        [ref.scope, ref.refId, ref.kind, ts, null, line],
      );
    }
  });
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
