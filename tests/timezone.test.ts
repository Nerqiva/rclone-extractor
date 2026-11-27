import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = `
import { APP_TZ } from "./src/config";
import { fmtDisplayTime } from "./src/ui";
console.log(JSON.stringify({ tz: APP_TZ, time: fmtDisplayTime("2026-01-01T00:00:00.000Z") }));
`;

function child(env: Record<string, string>) {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", SCRIPT],
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout).trim());
}

test("display times follow the host time zone by default", () => {
  const out = child({ TZ: "Etc/GMT-6", APP_TZ: "" });
  expect(out.tz).toBe("Etc/GMT-6");
  expect(out.time).toBe("06:00:00");
});

test("APP_TZ still overrides the host zone", () => {
  const out = child({ TZ: "Etc/GMT-6", APP_TZ: "Europe/Berlin" });
  expect(out.tz).toBe("Europe/Berlin");
  expect(out.time).toBe("01:00:00");
});

test("an invalid APP_TZ falls back to the host zone", () => {
  const out = child({ TZ: "Etc/GMT-6", APP_TZ: "Not/AZone" });
  expect(out.tz).toBe("Etc/GMT-6");
  expect(out.time).toBe("06:00:00");
});
