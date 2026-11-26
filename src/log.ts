import { store } from "./db";
import { esc, fmtDisplayTime } from "./ui";

const DASHES = "-".repeat(72);
const DASH_RE = /^-{40,}$/;

export type LogScope = "run" | "archive";
export type LogKind = "main" | "errors" | "extract";

export const LOG_TAIL_LIMIT = 300;

export const LOG_EXPORT_LIMIT = 50_000;

/** Neutral delimiter written into archive logs before each command's output. */
export const COMMAND_SEPARATOR = "---";

export function commandMarker(command: string): string[] {
  return [COMMAND_SEPARATOR, `$ ${command}`];
}

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
  // Log lines are stored in UTC; show them in the display timezone (APP_TZ,
  // default Asia/Omsk). Downloads keep the raw ISO value.
  return fmtDisplayTime(ts);
}

export interface RenderedEntry {
  html: string;
  level: string;
}

// Detail ids must be unique across the initial render and every live poll
// (each render restarts its local counter), so use one process-wide counter.
let detailIdSeq = 0;

function renderLogEntries(rows: LogRow[]): RenderedEntry[] {
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
    // Imported levels are arbitrary strings; the class wants a bare slug.
    const lvl = /^[a-z0-9-]+$/.test(level.toLowerCase())
      ? level.toLowerCase()
      : "info";
    const cls = isCmd ? "log-entry log-cmd" : `log-entry log-${lvl}`;
    const chip = level
      ? `<span class="log-chip log-chip-${lvl}">${esc(level)}</span>`
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
    if (detail === undefined) {
      this.write("ERROR", msg);
      return;
    }
    // Detail blocks are rows, not one embedded-newline string: the folder
    // (renderLogEntries) needs each dash line of its own to collapse.
    this.write("ERROR", msg);
    this.write(null, DASHES);
    for (const l of detail.split(/\r?\n/)) this.write(null, l);
    this.write(null, DASHES);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  static async flushAll(): Promise<void> {
    await Promise.allSettled([...Logger.pending]);
  }

  private write(level: string | null, line: string): void {
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

/** Insert log lines in one transaction. Raw output only: no app wording. */
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
  const rows = await store.query<LogRow>(
    "SELECT ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY id ASC LIMIT 50000",
    [ref.scope, ref.refId, ref.kind],
  );
  return rows.map(formatRow);
}
