import { store } from "./db";

const DASHES = "-".repeat(72);

export type LogScope = "run" | "archive";
export type LogKind = "main" | "errors" | "rclone" | "extract";

export interface LogRef {
  scope: LogScope;
  refId: number;
  kind: LogKind;
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

export async function tail(
  ref: LogRef,
  limit = 200,
): Promise<string[]> {
  const rows = await store.query<{ line: string }>(
    "SELECT line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY seq DESC LIMIT ?",
    [ref.scope, ref.refId, ref.kind, limit],
  );
  return rows.map((r) => r.line).reverse();
}

export async function readAll(ref: LogRef): Promise<string[]> {
  const rows = await store.query<{ ts: string; level: string | null; line: string }>(
    "SELECT ts, level, line FROM log_lines WHERE scope=? AND ref_id=? AND kind=? ORDER BY seq ASC",
    [ref.scope, ref.refId, ref.kind],
  );
  return rows.map((r) => `${r.ts} ${r.level ?? ""} ${r.line}`.trimEnd());
}
