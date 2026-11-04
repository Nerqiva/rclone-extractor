import { appendFileSync } from "node:fs";
import { LOG_DIR } from "./config";

const DASHES = "-".repeat(72);

export class Logger {
  constructor(private file: string) {}

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string, detail?: string): void {
    this.write("ERROR", msg);
    if (detail !== undefined) {
      appendFileSync(this.file, `${DASHES}\n${detail}\n${DASHES}\n`);
    }
  }

  private write(level: string, msg: string): void {
    appendFileSync(this.file, `${new Date().toISOString()} ${level} ${msg}\n`);
  }
}

export function logPath(name: string): string {
  return `${LOG_DIR}/${name}`;
}
