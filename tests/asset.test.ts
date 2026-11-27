import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATA_DIR = join("/tmp", `rx-asset-${process.pid}`);
delete process.env.DATABASE_URL;

const VERSION = readFileSync(join(import.meta.dir, "..", "VERSION"), "utf8").trim();

test("asset() busts /public/* caches with the release version", async () => {
  const { asset, layout } = await import("../src/ui");
  expect(asset("styles.css")).toBe(`/public/styles.css?v=${VERSION}`);
  const html = layout("t", "<p>x</p>", "test");
  expect(html).toContain(`href="/public/styles.css?v=${VERSION}"`);
  expect(html).toContain(`src="/public/htmx.min.js?v=${VERSION}"`);
  expect(html).not.toContain('href="/public/styles.css"');
});

test("the shared client runtime ships the htmx:beforeSwap tooltip guard", async () => {
  const { asset, layout } = await import("../src/ui");
  const html = layout("t", "<p>x</p>", "test");
  expect(html).toContain(`src="${asset("app.js")}"`);
  const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  expect(app).toContain("htmx:beforeSwap");
  expect(app).toContain('querySelector(".info-tip.open")');
});
