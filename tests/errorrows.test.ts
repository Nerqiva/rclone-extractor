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
      "---",
      "$ rclone --config /data/tmp/c.conf purge tmp/broken",
      "cleanup failed: permission denied",
    ],
  );
  const rows = await import("../src/errorrows");
  readErrorRows = rows.readErrorRows;
  renderErrorCards = rows.renderErrorCards;
});

test("error cards show the failing command with raw native output", async () => {
  const rows = await readErrorRows(store);
  const row = rows.find((r) => Number(r.id) === archiveId);
  expect(row).toBeDefined();
  expect(row!.message).toContain("ERROR: archive broken.zip: corrupt zip data");
  expect(row!.message).toContain("failed to unzip: invalid signature");
  expect(row!.message).toContain("$ rclone");
  expect(row!.message).toContain("archive extract");
  expect(row!.message).not.toContain("purge");
  expect(row!.message).not.toContain("cleanup failed");
  expect(row!.message).not.toContain("---");
  expect(row!.message).not.toContain("skipped (tiny)");
  const html = renderErrorCards(rows);
  expect(html).toContain("ERROR: archive broken.zip: corrupt zip data");
  expect(html).toContain('class="error-message"');
  expect(html).toContain(`Queue ID #${archiveId}`);
});

test("informational skips are separated from failures", async () => {
  const now = new Date().toISOString();
  await store.run(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES('incoming/tiny.zip', 10, 'skipped', 'tiny', ?, ?)",
    [now, now],
  );
  const html = renderErrorCards(await readErrorRows(store));
  const skipHeading = html.indexOf("Informational skips");
  expect(skipHeading).toBeGreaterThan(-1);
  expect(html).toContain("tiny.zip");
  expect(html).toContain('class="pill info"');
  expect(html.indexOf("tiny.zip")).toBeGreaterThan(skipHeading);
  expect(html.indexOf("broken.zip")).toBeLessThan(skipHeading);
});

test("error cards show the failed stage and an inline log view", async () => {
  const now = new Date().toISOString();
  const id = await store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES('incoming/staged.zip', 100, 'failed', 'promote', ?, ?)",
    [now, now],
  );
  const { insertLogLines } = await import("../src/log");
  await insertLogLines(
    { scope: "archive", refId: id, kind: "extract" },
    [
      "---",
      "$ [Moving to destination] rclone move tmp/out remote/incoming",
      "native move failure",
    ],
  );
  const rows = await readErrorRows(store);
  const row = rows.find((r) => Number(r.id) === id);
  expect(row).toBeDefined();
  expect(row!.stage).toBe("Moving to destination");
  const html = renderErrorCards(rows);
  expect(html).toContain("failed at");
  expect(html).toContain("Moving to destination");
  expect(html).toContain(`data-log-toggle="${id}"`);
  expect(html).toContain(`id="er-log-${id}"`);
});
