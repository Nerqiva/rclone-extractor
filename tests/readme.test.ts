import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Documentation drift guard.
 *
 * Asserts that the surfaces a user interacts with are mentioned in README.md:
 *   - every HTTP route registered by the app
 *   - every environment variable read by config.ts
 *   - every user-facing setting exposed by the config form
 *
 * This catches the common drift where code gains a route, env var, or setting
 * but the documented lists are not updated.
 */
const ROOT = join(import.meta.dir, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

async function collectRoutes(): Promise<{ method: string; path: string }[]> {
  const modules = await Promise.all([
    import("../src/routes/auth"),
    import("../src/routes/pages"),
    import("../src/routes/dashboard"),
    import("../src/routes/actions"),
    import("../src/routes/logsapi"),
    import("../src/routes/data"),
  ]);
  const out: { method: string; path: string }[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      const maybeRouter = value as { routes?: { method: string; path: string }[] };
      if (maybeRouter && Array.isArray(maybeRouter.routes)) {
        for (const r of maybeRouter.routes) {
          if (r.method === "ALL") continue; // middleware mounts
          out.push({ method: r.method, path: r.path });
        }
      }
    }
  }
  out.push({ method: "GET", path: "/healthz" }); // defined directly in server.ts
  return out;
}

function collectEnvVars(): string[] {
  const config = readFileSync(join(ROOT, "src/config.ts"), "utf8");
  const names = new Set<string>();
  for (const m of config.matchAll(/process\.env\.(\w+)/g)) names.add(m[1]);
  return [...names];
}

function collectSettings(): string[] {
  const actions = readFileSync(join(ROOT, "src/routes/actions.ts"), "utf8");
  const block = /const SETTING_KEYS\s*=\s*\[([^\]]+)\]/.exec(actions)?.[1] ?? "";
  const keys = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  // Settings set individually rather than in the key list.
  keys.push("dry_run", "resume", "database_url", "rclone_conf");
  return [...new Set(keys)];
}

test("every registered route is documented in README.md", async () => {
  const routes = await collectRoutes();
  const missing = routes.filter((r) => !readme.includes(r.path));
  expect(missing.map((r) => `${r.method} ${r.path}`)).toEqual([]);
});

test("README documents the injected /public/* static mount", () => {
  expect(readme.includes("/public/*")).toBe(true);
});

test("every environment variable is documented in README.md", () => {
  const missing = collectEnvVars().filter((v) => !readme.includes(v));
  expect(missing).toEqual([]);
});

test("every user-facing setting is documented in README.md", () => {
  const missing = collectSettings().filter((s) => !readme.includes(s));
  expect(missing).toEqual([]);
});

/** Paths listed in the README's "### HTTP routes" fenced code block. */
function documentedRouteBlock(): string {
  const after = readme.split("### HTTP routes")[1] ?? "";
  const fence = after.split("```");
  return fence[1] ?? "";
}

function documentedRoutePaths(): string[] {
  const block = documentedRouteBlock();
  const paths = new Set<string>();
  for (const m of block.matchAll(/\/[A-Za-z0-9_:*/-]+/g)) paths.add(m[0]);
  return [...paths];
}

async function liveRoutePaths(): Promise<Set<string>> {
  const routes = await collectRoutes();
  const paths = new Set(routes.map((r) => r.path));
  paths.add("/public/*"); // injected static mount from server.ts
  return paths;
}

test("README documents no routes that no longer exist", async () => {
  const live = await liveRoutePaths();
  const stale = documentedRoutePaths().filter((p) => !live.has(p));
  expect(stale).toEqual([]);
});

