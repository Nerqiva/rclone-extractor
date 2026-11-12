import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("force stop kills the in-flight extract and re-queues the archive", () => {
  const base = mkdtempSync(join(tmpdir(), "rx-forcestop-"));
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });
  const dataDir = join(base, "data");

  // rclone mock: the extract sleeps long enough to be killed mid-flight.
  const script = `#!/bin/sh
# strip leading hard-coded --config <path> pair
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  echo "./big.zip;50000"
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  printf '40000 ./big.bin\\n'
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  exec sleep 60
fi
exit 0
`;
  const binPath = join(binDir, "rclone");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  const probe = `
import { initDb, store, setSetting } from "./src/db";
import { runEngine, engineState, forceStopEngine } from "./src/engine";
await initDb();
await setSetting("scan_root", process.env.SCAN_ROOT);
await setSetting("remote_flags", "");
await setSetting("cancel", "0");
const engine = runEngine();
const deadline = Date.now() + 10000;
while (engineState.stage !== "extracting" || !engineState.currentRel) {
  if (Date.now() > deadline) { console.error("never reached extracting"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 50));
}
forceStopEngine();
await engine;
const rows = await store.query("SELECT status FROM archives");
console.log("PROBE " + JSON.stringify({
  stage: engineState.stage,
  running: engineState.running,
  stopRequested: engineState.stopRequested,
  forceStop: engineState.forceStop,
  done: engineState.done,
  failed: engineState.failed,
  skipped: engineState.skipped,
  statuses: rows.map((r) => r.status),
}));
await store.close();
`;

  const result = spawnSync(
    process.execPath,
    ["-e", probe],
    {
      cwd: join(__dirname, ".."),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DATA_DIR: dataDir,
        SCAN_ROOT: scanRoot,
        DATABASE_URL: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const line = result.stdout.split("\n").find((l) => l.startsWith("PROBE "));
  expect(line).toBeTruthy();
  const state = JSON.parse(line!.slice("PROBE ".length));

  expect(state.stage).toBe("interrupted");
  expect(state.running).toBe(false);
  expect(state.stopRequested).toBe(false);
  expect(state.forceStop).toBe(false);
  // The aborted archive is back in the queue and counted nowhere.
  expect(state.done).toBe(0);
  expect(state.failed).toBe(0);
  expect(state.skipped).toBe(0);
  expect(state.statuses).toEqual(["queued"]);
}, 40_000);
