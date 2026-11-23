import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("purgeStaleTemp leaves live peers' run directories alone", () => {
  const base = mkdtempSync(join(tmpdir(), "rx-tmppeer-"));
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(base, "purged.txt");
  const tmpAbs = join(base, "tmp");
  mkdirSync(tmpAbs, { recursive: true });
  const script = `#!/bin/sh
if [ "$1" = "--config" ]; then shift 2; fi
if [ "$1" = "lsf" ]; then
  printf 'run_123/\\nrun_456/\\n'
  exit 0
fi
if [ "$1" = "purge" ]; then
  echo "$2" >> "${marker}"
  exit 0
fi
exit 0
`;
  const binPath = join(binDir, "rclone");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  const probe = `
import { Rclone } from "./src/rclone";
const rc = new Rclone("rclone", ${JSON.stringify(tmpAbs)}, {});
const res = await rc.purgeStaleTemp(${JSON.stringify(tmpAbs)}, new Set([123]));
const purged = require("node:fs").readFileSync(${JSON.stringify(marker)}, "utf8");
console.log("PROBE " + JSON.stringify({ res, purged }));
`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  const line = result.stdout.split("\n").find((l) => l.startsWith("PROBE "));
  expect(line).toBeTruthy();
  const out = JSON.parse(line!.slice("PROBE ".length));
  expect(out.res.purged).toEqual(["run_456"]);
  expect(out.res.skipped).toEqual(["run_123"]);
  expect(out.purged).not.toContain("run_123");
}, 40_000);
