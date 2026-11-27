import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-errcmd-"));
delete process.env.DATABASE_URL;

let db: typeof import("../src/db");
let engine: typeof import("../src/engine");
let runId = 0;

const script = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  echo "./broken.zip;100000"
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '50000 ./payload.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  echo "native error: unsupported compression method" 1>&2
  exit 1
fi
exit 0
`;

beforeAll(async () => {
  const base = process.env.DATA_DIR!;
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "rclone");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  await db.setSetting("scan_root", join(base, "scan"));
  await db.setSetting("remote_flags", "");
  // This suite tests error logging, not retries: keep its failing extract fast.
  await db.setSetting("retry_cooldown_seconds", "0");
  engine = await import("../src/engine");
  await engine.runEngine();
  const row = await db.store.get1<{ id: number }>(
    "SELECT id FROM runs ORDER BY id DESC LIMIT 1",
  );
  runId = Number(row?.id ?? 0);
});

test("error log includes the failing binary command alongside native output", async () => {
  const logs = await db.store.query<{ line: string }>(
    "SELECT line FROM log_lines WHERE scope='run' AND ref_id=? AND kind='errors'",
    [runId],
  );
  const text = logs.map((l) => l.line).join("\n");
  expect(text).toContain("native error: unsupported compression method");
  expect(text).toMatch(/\$ rclone .*archive extract/);
});
