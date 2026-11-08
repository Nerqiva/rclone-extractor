import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("purgeStaleTemp purges only app-layout dirs inside the temp root", () => {
  const base = mkdtempSync(join(tmpdir(), "rx-tmpsweep-"));
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(base, "purged.txt");
  const tmpAbs = join(base, "tmp");
  mkdirSync(tmpAbs, { recursive: true });

  // mock rclone: lsf prints dirs (one stray, two app-layout), purge appends to a marker
  const script = `#!/bin/sh
if [ "$1" = "lsf" ]; then
  case "$2" in
    *${tmpAbs}*)
      printf '123/\\nkeep-me/\\n456/\\n'
      exit 0
      ;;
  esac
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
const rc = new Rclone("rclone", ${JSON.stringify(tmpAbs)}, []);
const res = await rc.purgeStaleTemp(${JSON.stringify(tmpAbs)}, false);
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
  expect(out.res.purged.sort()).toEqual(["123", "456"]);
  expect(out.res.skipped).toEqual(["keep-me"]);
  expect(out.res.failed).toEqual([]);
  expect(out.purged).toContain("/123\n");
  expect(out.purged).toContain("/456\n");
  expect(out.purged).not.toContain("keep-me");
}, 40_000);

test("purgeStaleTemp in dry-run reports without deleting", () => {
  const base = mkdtempSync(join(tmpdir(), "rx-tmpsweep-dry-"));
  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(base, "purged.txt");
  const tmpAbs = join(base, "tmp");
  mkdirSync(tmpAbs, { recursive: true });

  const script = `#!/bin/sh
if [ "$1" = "lsf" ]; then
  printf '123/\\n'
  exit 0
fi
if [ "$1" = "purge" ]; then
  echo "$*" >> "${marker}"
  exit 0
fi
exit 0
`;
  const binPath = join(binDir, "rclone");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  const probe = `
import { Rclone } from "./src/rclone";
const rc = new Rclone("rclone", ${JSON.stringify(tmpAbs)}, []);
const res = await rc.purgeStaleTemp(${JSON.stringify(tmpAbs)}, true);
console.log("PROBE " + JSON.stringify({ res }));
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
  expect(out.res.purged).toEqual(["123"]);
  // dry-run: the mock only sees a purge invocation with --dry-run
  const markerContent = readFileSync(marker, "utf8");
  expect(markerContent).toContain("--dry-run");
}, 40_000);
