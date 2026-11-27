import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-pwtab-"));
delete process.env.DATABASE_URL;

// Mock rclone. `lsl` decides existence from marker files under MOCK_MARKERS;
// `moveto`/`cat` always succeed and log their argv into MOVELOG.
const mockMarkers = join(process.env.DATA_DIR, "markers");
mkdirSync(mockMarkers, { recursive: true });
const binDir = join(process.env.DATA_DIR, "bin");
mkdirSync(binDir, { recursive: true });
const moveLog = join(process.env.DATA_DIR, "move.log");
const mockScript = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
echo "$@" >> ${moveLog}
case "$1" in
  lsl)
    path="$2"
    case "$path" in
      *trash*) if [ -f "${mockMarkers}/trash_exists" ]; then echo "100 2024-01-01 00:00:00 file"; exit 0; fi; exit 3 ;;
      *) if [ -f "${mockMarkers}/root_exists" ]; then echo "100 2024-01-01 00:00:00 file"; exit 0; fi; exit 3 ;;
    esac
    ;;
  moveto|cat)
    exit 0
    ;;
esac
exit 0
`;
writeFileSync(join(binDir, "rclone"), mockScript, { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;
process.env.MOCK_MARKERS = mockMarkers;

let store: typeof import("../src/db").store;
let setSetting: typeof import("../src/db").setSetting;
let engineState: typeof import("../src/engine").engineState;
let drainDeferredPasswordMoves: typeof import("../src/engine").drainDeferredPasswordMoves;
let queuePasswordMove: typeof import("../src/engine").queuePasswordMove;
let forceStopEngine: typeof import("../src/engine").forceStopEngine;
let actions: Hono;

async function insertPasswordArchive(path: string, status = "skipped"): Promise<number> {
  const created = new Date().toISOString();
  return store.insertReturningId(
    "INSERT INTO archives(path, size, status, error_kind, created_at, updated_at) VALUES(?, ?, ?, 'password', ?, ?)",
    [path, 12345, status, created, created],
  );
}

beforeAll(async () => {
  const db = await import("../src/db");
  store = db.store;
  setSetting = db.setSetting;
  await db.initDb();
  const engine = await import("../src/engine");
  engineState = engine.engineState;
  drainDeferredPasswordMoves = engine.drainDeferredPasswordMoves;
  queuePasswordMove = engine.queuePasswordMove;
  forceStopEngine = engine.forceStopEngine;
  const scanRoot = join(process.env.DATA_DIR!, "scan");
  mkdirSync(scanRoot, { recursive: true });
  await setSetting("scan_root", scanRoot);
  await setSetting("trash_subdir", "trash"); // pin it; mock markers key off "trash"
  actions = (await import("../src/routes/actions")).actions;
  const app = new Hono();
  app.route("/", actions);
});

afterEach(() => {
  engineState.running = false;
  engineState.forceStop = false;
  engineState.deferredPasswordMoves = [];
});

test("renderPasswordList shows empty state and both row states", async () => {
  const { renderPasswordList } = await import("../src/passwordrows");
  expect(renderPasswordList([])).toContain("No password-protected archives");
  const html = renderPasswordList([
    { id: 7, path: "a/b/c.7z", size: 2048, status: "skipped", updated_at: new Date().toISOString() },
    { id: 8, path: "d/e.rar", size: 4096, status: "deleted", updated_at: new Date().toISOString() },
  ]);
  expect(html).toContain("a/b/c.7z");
  expect(html).toContain("/archives/7/delete");
  expect(html).toContain("/archives/8/restore");
  expect(html).toContain("/download/archive-file/7");
  expect(html).toContain("password");
  expect(html).toContain("in trash");
  expect(html).toContain("Queue ID #7");
  expect(html).toContain("Queue ID #8");
});

test("delete moves the archive to trash and flips the row to deleted", async () => {
  const id = await insertPasswordArchive("some/protected.7z");
  const res = await actions.request(`/archives/${id}/delete`, { method: "POST" });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("in trash");
  const row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
  expect(row?.status).toBe("deleted");
  expect(existsSync(moveLog)).toBe(true);
});

test("delete refuses when the trash already contains the archive", async () => {
  writeFileSync(join(mockMarkers, "trash_exists"), "");
  try {
    const id = await insertPasswordArchive("dup/protected.7z");
    const res = await actions.request(`/archives/${id}/delete`, { method: "POST" });
    expect(res.headers.get("HX-Trigger")).toContain("trash already contains");
    const row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
    expect(row?.status).toBe("skipped");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(join(mockMarkers, "trash_exists"), { force: true });
  }
});

test("delete is queued while a task is running and applied on drain", async () => {
  engineState.running = true;
  const id = await insertPasswordArchive("live/protected.7z");
  const res = await actions.request(`/archives/${id}/delete`, { method: "POST" });
  expect(res.headers.get("HX-Trigger")).toContain("Queued");
  let row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
  expect(row?.status).toBe("skipped");
  expect(engineState.deferredPasswordMoves.some((m) => m.id === id && m.direction === "delete")).toBe(true);
  await drainDeferredPasswordMoves();
  row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
  expect(row?.status).toBe("deleted");
  expect(engineState.deferredPasswordMoves.length).toBe(0);
});

test("restore is queued while a task is running and applied on drain", async () => {
  writeFileSync(join(mockMarkers, "trash_exists"), "");
  try {
    engineState.running = true;
    const id = await insertPasswordArchive("livequeued/protected.rar", "deleted");
    const res = await actions.request(`/archives/${id}/restore`, { method: "POST" });
    expect(res.headers.get("HX-Trigger")).toContain("Queued");
    expect(res.headers.get("HX-Trigger")).toContain("restore");
    expect(engineState.deferredPasswordMoves.some((m) => m.id === id && m.direction === "restore")).toBe(true);
    await drainDeferredPasswordMoves();
    const row = await store.get1<{ status: string; error_kind: string | null }>(
      "SELECT status, error_kind FROM archives WHERE id = ?",
      [id],
    );
    expect(row?.status).toBe("queued");
    expect(row?.error_kind).toBeNull();
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(join(mockMarkers, "trash_exists"), { force: true });
  }
});

test("a duplicate queued move is rejected", async () => {
  engineState.running = true;
  const id = await insertPasswordArchive("dupe/dup.7z");
  const first = await actions.request(`/archives/${id}/delete`, { method: "POST" });
  expect(first.headers.get("HX-Trigger")).toContain("Queued");
  const second = await actions.request(`/archives/${id}/delete`, { method: "POST" });
  expect(second.headers.get("HX-Trigger")).toContain("already queued");
  expect(engineState.deferredPasswordMoves.filter((m) => m.id === id).length).toBe(1);
});

test("drain re-validates and skips a move whose row changed", async () => {
  engineState.running = true;
  const id = await insertPasswordArchive("changed/protected.7z");
  queuePasswordMove("delete", id);
  // The row stops being a password archive before the drain runs.
  await store.run("UPDATE archives SET error_kind=NULL WHERE id=?", [id]);
  await drainDeferredPasswordMoves();
  const row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
  expect(row?.status).toBe("skipped");
  expect(engineState.deferredPasswordMoves.length).toBe(0);
});

test("a hard stop discards pending password moves", async () => {
  engineState.running = true;
  const id = await insertPasswordArchive("hardstop/protected.7z");
  queuePasswordMove("delete", id);
  forceStopEngine();
  expect(engineState.deferredPasswordMoves.length).toBe(0);
});

test("renderPasswordList marks a pending row and disables its action button", async () => {
  const { renderPasswordList } = await import("../src/passwordrows");
  const id = await insertPasswordArchive("pending/protected.7z");
  queuePasswordMove("delete", id);
  const html = renderPasswordList([
    { id, path: "pending/protected.7z", size: 1, status: "skipped", updated_at: new Date().toISOString() },
  ]);
  expect(html).toContain("pending");
  expect(html).toContain("disabled");
});

test("restore moves the archive back and re-queues it", async () => {
  // The trash copy (the restore source) must exist.
  writeFileSync(join(mockMarkers, "trash_exists"), "");
  try {
    const id = await insertPasswordArchive("restore/protected.rar", "deleted");
    const res = await actions.request(`/archives/${id}/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    const row = await store.get1<{ status: string; error_kind: string | null }>(
      "SELECT status, error_kind FROM archives WHERE id = ?",
      [id],
    );
    expect(row?.status).toBe("queued");
    expect(row?.error_kind).toBeNull();
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(join(mockMarkers, "trash_exists"), { force: true });
  }
});

test("restore drops the entry when the trash copy is gone", async () => {
  // No trash_exists marker: the file vanished from the trash (removed by
  // hand, say). Restore must clean up the stale row, not fail forever.
  const id = await insertPasswordArchive("gone/protected.rar", "deleted");
  const res = await actions.request(`/archives/${id}/restore`, { method: "POST" });
  expect(res.headers.get("HX-Trigger")).toContain("no longer in the trash");
  const row = await store.get1<{ id: number }>("SELECT id FROM archives WHERE id = ?", [id]);
  expect(row).toBeFalsy();
});

test("restore refuses when a file now exists at the original path", async () => {
  writeFileSync(join(mockMarkers, "root_exists"), "");
  writeFileSync(join(mockMarkers, "trash_exists"), ""); // trash copy (source) exists
  try {
    const id = await insertPasswordArchive("back/protected.rar", "deleted");
    const res = await actions.request(`/archives/${id}/restore`, { method: "POST" });
    expect(res.headers.get("HX-Trigger")).toContain("now exists");
    const row = await store.get1<{ status: string }>("SELECT status FROM archives WHERE id = ?", [id]);
    expect(row?.status).toBe("deleted");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(join(mockMarkers, "root_exists"), { force: true });
    rmSync(join(mockMarkers, "trash_exists"), { force: true });
  }
});

test("errors page rows exclude password archives", async () => {
  await setSetting("trash_subdir", "trash");
  await insertPasswordArchive("hidden/protected.7z");
  const { readErrorRows } = await import("../src/errorrows");
  const rows = await readErrorRows(store);
  expect(rows.every((r) => r.error_kind !== "password")).toBe(true);
});
