import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-log-"));
delete process.env.DATABASE_URL;

let store: typeof import("../src/db").store;
let Logger: typeof import("../src/log").Logger;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  Logger = (await import("../src/log")).Logger;
});

test("serialized logger writes land in order", async () => {
  const logger = new Logger({ scope: "run", refId: 987001, kind: "main" });
  for (let i = 0; i < 25; i++) logger.info(`line ${i}`);
  await logger.flush();
  await Logger.flushAll();
  const rows = await store.query<{ line: string; id: number }>(
    "SELECT line, id FROM log_lines WHERE scope='run' AND ref_id=987001 AND kind='main' ORDER BY id ASC",
  );
  expect(rows.length).toBe(25);
  rows.forEach((row, i) => {
    expect(row.line).toBe(`line ${i}`);
  });
});
