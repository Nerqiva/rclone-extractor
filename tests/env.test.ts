import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SnapDeploy detects deploy-time environment variables by scanning the
 * repository for Dockerfile, .env.example and framework config. This guard
 * makes sure every variable config.ts reads is advertised in .env.example,
 * so `DATABASE_URL` (and the others) show up on the deploy screen.
 */
const ROOT = join(import.meta.dir, "..");

function collectEnvVars(): string[] {
  const config = readFileSync(join(ROOT, "src/config.ts"), "utf8");
  const names = new Set<string>();
  for (const m of config.matchAll(/process\.env\.(\w+)/g)) names.add(m[1]);
  return [...names];
}

test(".env.example advertises every env var read by config.ts", () => {
  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  const missing = collectEnvVars().filter(
    (name) => !new RegExp(`^${name}=`, "m").test(envExample),
  );
  expect(missing).toEqual([]);
});

test(".env.example offers DATABASE_URL (optional, empty by default)", () => {
  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  expect(/^DATABASE_URL=\s*(#.*)?$/m.test(envExample)).toBe(true);
});
