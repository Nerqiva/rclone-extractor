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
  expect(html).toContain(`src="${asset("morphdom-umd.min.js")}"`);
  expect(html).toContain('hx-ext="app-morph"');
  expect(html).not.toContain('href="/public/styles.css"');
});

test("the shared client runtime ships the htmx:beforeSwap tooltip guard", async () => {
  const { asset, layout } = await import("../src/ui");
  const html = layout("t", "<p>x</p>", "test");
  expect(html).toContain(`src="${asset("app.js")}"`);
  const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  expect(app).toContain("htmx:beforeSwap");
  expect(app).toContain('querySelector(".info-tip.open")');
  expect(app).toContain('htmx.defineExtension("app-morph"');
  const copy = readFileSync(join(import.meta.dir, "..", "public", "copy.js"), "utf8");
  expect(copy).toContain("/logs/fragment?run=");
  expect(copy).not.toContain("dataset.kind");
  expect(copy).not.toContain("&kind=");
});

test("the help indicator is a tiny SVG question mark and the nav uses a slim active marker", async () => {
  const { info } = await import("../src/ui");
  expect(info("tip", "thing")).toContain('class="info-i"');
  expect(info("tip", "thing")).toContain("<svg");
  expect(info("tip", "thing")).toContain('stroke="currentColor"');
  expect(info("tip", "thing")).not.toContain(">?</button>");
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  const marker = css.slice(css.indexOf(".info-i {"), css.indexOf(".info-i svg {"));
  expect(marker).toContain("vertical-align: super");
  expect(marker).toContain("color: var(--faint)");
  expect(marker).not.toContain("border-radius");
  expect(marker).not.toContain("width:");
  const glyph = css.slice(css.indexOf(".info-i svg {"), css.indexOf(".info-i:hover"));
  expect(glyph).toContain("width: 9px");
  expect(glyph).toContain("height: 9px");
  const hover = css.slice(css.indexOf(".info-i:hover,"), css.indexOf("@media (hover: none)"));
  expect(hover).toContain("color: var(--accent)");
  const bubble = css.slice(css.indexOf(".info-tip-bubble {"), css.indexOf(".info-tip:hover"));
  expect(bubble).toContain("font-family: var(--font-ui)");
  expect(bubble).toContain("font-weight: 400");
  const nav = css.slice(css.indexOf(".nav-link {"), css.indexOf(".rail-foot {"));
  expect(nav).toContain("-webkit-tap-highlight-color: transparent");
  expect(nav).not.toContain("background: rgba(");
  expect(nav).toContain("box-shadow: inset 2px 0 0 var(--accent)");
});

test("log rows keep a minimal left gutter", async () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  const entry = css.slice(css.indexOf(".log-entry {"), css.indexOf(".log-entry:last-child"));
  expect(entry).toContain("padding: 2px 8px");
  const time = css.slice(css.indexOf(".log-time {"), css.indexOf(".log-chip {"));
  expect(time).toContain("flex: 0 0 48px");
  const continuation = css.slice(css.indexOf(".log-continuation {"), css.indexOf(".log-detail {"));
  expect(continuation).toContain("padding-left: 8px");
});

test("archive cards keep their header inline and show retry and cooldown chips", async () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  const jobHead = css.slice(css.indexOf(".job-card-head {"), css.indexOf(".job-card-foot {"));
  const errorHead = css.slice(css.indexOf(".error-card-head {"), css.indexOf(".error-name {"));
  expect(jobHead).not.toContain("justify-content: space-between");
  expect(errorHead).not.toContain("justify-content: space-between");
  expect(css).toContain(".retry-info,");
  expect(css).toContain(".cooldown-info {");
  const { renderArchiveLogRows } = await import("../src/archiverows");
  const row = {
    id: 7,
    path: "incoming/a.zip",
    size: 10,
    status: "extracting",
    error_kind: null,
    updated_at: new Date().toISOString(),
  };
  const jobs = new Map([[7, { phase: "Extracting", status: "active", stats: null, attempt: 2, cooldownUntil: Date.now() + 30_000 }]]);
  const html = renderArchiveLogRows([row], jobs);
  expect(html).toContain("retry 1/3");
  expect(html).toContain("cooldown 30s");
  expect(renderArchiveLogRows([row], new Map([[7, { phase: "Extracting", status: "active", stats: null, attempt: 1, cooldownUntil: 0 }]]))).not.toContain("retry 1/3");
});

test("the UI face is self-hosted Inter and data stays monospace", async () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  expect(css).toContain('font-family: "Inter"');
  expect(css).toContain('src: url("/public/fonts/inter-latin-var.woff2")');
  expect(css).toContain('--font-ui: "Inter"');
  expect(css).toContain("--font-data: var(--mono)");
  const font = readFileSync(
    join(import.meta.dir, "..", "public", "fonts", "inter-latin-var.woff2"),
  );
  expect(font.subarray(0, 4).toString("ascii")).toBe("wOF2");
});

test("the client runtime morphs polled fragments instead of repeating their HTML", async () => {
  const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  const copy = readFileSync(join(import.meta.dir, "..", "public", "copy.js"), "utf8");
  const morphdom = readFileSync(
    join(import.meta.dir, "..", "public", "morphdom-umd.min.js"),
    "utf8",
  );
  expect(app).toContain("morphdom(target, wrap, { childrenOnly: true })");
  expect(app).not.toContain("__pollHtml");
  expect(copy).toContain("window.appMorph(errorCards, payload.html)");
  expect(morphdom).toContain("morphdom");
});
