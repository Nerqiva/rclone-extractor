import { test, expect, beforeAll } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Native binary errors can arrive on stdout during `archive list`. They must
 * be kept verbatim in the per-archive log (which holds raw binary output
 * only), and they must still drive password/unreadable classification.
 */
let db: typeof import("../src/db") | null = null;
let engineState: typeof import("../src/engine").engineState;
let runEngine: typeof import("../src/engine").runEngine;
let readAll: typeof import("../src/log").readAll;
let base = "";

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "rx-nativelog-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(
    join(binDir, "rclone"),
    `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then printf './locked.zip;300000\\n'; exit 0; fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  echo "2026/11/23 10:00:00 ERROR: native binary password required for locked.zip"
  echo "2026/11/23 10:00:00 ERROR: native binary wrong password"
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "rclone"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  await db.setSetting("scan_root", scanRoot);
  await db.setSetting("scan_cache_state", "incomplete");
  await db.setSetting("scan_cache_key", "");
  const eng = await import("../src/engine");
  engineState = eng.engineState;
  runEngine = eng.runEngine;
  readAll = (await import("../src/log")).readAll;
  await runEngine();
});

test("stdout native errors are stored verbatim in the archive log", async () => {
  const row = await db!.store.get1<{ id: number }>(
    "SELECT id FROM archives WHERE path='locked.zip'",
  );
  expect(row).toBeDefined();
  const lines = await readAll({
    scope: "archive",
    refId: Number(row!.id),
    kind: "extract",
  });
  expect(lines.some((l) => l.includes("native binary password required"))).toBe(true);
  expect(lines.some((l) => l.includes("native binary wrong password"))).toBe(true);
  expect(lines.some((l) => l.includes("skipped ("))).toBe(false);
  expect(lines.some((l) => l.includes("listing failed (exit"))).toBe(false);
});

test("stdout native errors still classify the archive as password", async () => {
  const row = await db!.store.get1<{ error_kind: string; status: string }>(
    "SELECT error_kind, status FROM archives WHERE path='locked.zip'",
  );
  expect({ ...row }).toMatchObject({ status: "skipped", error_kind: "password" });
});
