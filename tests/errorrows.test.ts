import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-errorrows-"));
delete process.env.DATABASE_URL;

let store: typeof import("../src/db").store;
let archiveId: number;
let readErrorRows: typeof import("../src/errorrows").readErrorRows;
let renderErrorCards: typeof import("../src/errorrows").renderErrorCards;

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  await db.initDb();
  const now = new Date().toISOString();
  archiveId = await store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES('incoming/broken.zip', 100, 'failed', 'extract', ?, ?)",
    [now, now],
  );
  const { insertLogLines } = await import("../src/log");
  await insertLogLines(
    { scope: "archive", refId: archiveId, kind: "extract" },
    [
      "$ rclone --config /data/tmp/c.conf archive extract broken.zip tmp",
      "2026/11/23 10:00:00 ERROR: archive broken.zip: corrupt zip data",
      "skipped (tiny): broken.zip",
      "failed to unzip: invalid signature",
    ],
  );
  const rows = await import("../src/errorrows");
  readErrorRows = rows.readErrorRows;
  renderErrorCards = rows.renderErrorCards;
});

test("error cards show raw native output without app wording", async () => {
  const rows = await readErrorRows(store);
  const row = rows.find((r) => Number(r.id) === archiveId);
  expect(row).toBeDefined();
  expect(row!.message).toContain("ERROR: archive broken.zip: corrupt zip data");
  expect(row!.message).toContain("failed to unzip: invalid signature");
  expect(row!.message).not.toContain("$ rclone");
  expect(row!.message).not.toContain("skipped (tiny)");
  const html = renderErrorCards(rows);
  expect(html).toContain("ERROR: archive broken.zip: corrupt zip data");
  expect(html).toContain('class="error-message"');
});
