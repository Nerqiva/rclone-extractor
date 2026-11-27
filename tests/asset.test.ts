import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATA_DIR = join("/tmp", `rx-asset-${process.pid}`);
delete process.env.DATABASE_URL;

const VERSION = readFileSync(join(import.meta.dir, "..", "VERSION"), "utf8").trim();

function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing CSS rule: ${selector}`);
  const end = css.indexOf("\n}", start);
  if (end < 0) throw new Error(`unterminated CSS rule: ${selector}`);
  return css.slice(start, end + 2);
}

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

test("copy.js uses the shared fetch and error helpers from app.js", () => {
  const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  const copy = readFileSync(join(import.meta.dir, "..", "public", "copy.js"), "utf8");
  expect(app).toContain("window.appFetchText = fetchText");
  expect(app).toContain("window.appErrText = errText");
  expect(copy).toContain("window.appFetchText(url)");
  expect(copy).toContain("window.appErrText(err)");
  expect(copy).not.toContain('throw new Error("HTTP " + response.status)');
});

test("one shared poll timer drives queue, downloads, log and errors", () => {
  const app = readFileSync(join(import.meta.dir, "..", "public", "app.js"), "utf8");
  const copy = readFileSync(join(import.meta.dir, "..", "public", "copy.js"), "utf8");
  expect(app).toContain("window.appPoll = createPoll");
  expect(app).toContain("start: function ()");
  expect(app).toContain("stop: function ()");
  expect((app.match(/window\.setInterval\(/g) || []).length).toBe(1);
  expect(copy).toContain('window.appPoll("log"');
  expect(copy).toContain('window.appPoll("errors"');
  expect(copy).toContain("logPoll.start()");
  expect(copy).toContain("errorsPoll.stop()");
  expect(copy).not.toContain("window.setInterval");
  expect(copy).not.toContain("window.clearInterval");
});

test("the help indicator is a tiny SVG question mark and the nav uses a slim active marker", async () => {
  const { info } = await import("../src/ui");
  expect(info("tip", "thing")).toContain('class="info-i"');
  expect(info("tip", "thing")).toContain("<svg");
  expect(info("tip", "thing")).toContain('stroke="currentColor"');
  expect(info("tip", "thing")).not.toContain(">?</button>");
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  const marker = cssRule(css, ".info-i");
  expect(marker).toContain("vertical-align: super");
  expect(marker).toContain("color: var(--faint)");
  expect(marker).not.toContain("border-radius");
  expect(marker).not.toContain("width:");
  const glyph = cssRule(css, ".info-i svg");
  expect(glyph).toContain("width: 9px");
  expect(glyph).toContain("height: 9px");
  const hover = css.slice(css.indexOf(".info-i:hover,"), css.indexOf("@media (hover: none)"));
  expect(hover).toContain("color: var(--accent)");
  const bubble = cssRule(css, ".info-tip-bubble");
  expect(bubble).toContain("font-family: var(--font-ui)");
  expect(bubble).toContain("font-weight: 400");
  const nav = cssRule(css, ".nav-link");
  expect(nav).toContain("-webkit-tap-highlight-color: transparent");
  expect(nav).not.toContain("background: rgba(");
  expect(cssRule(css, ".nav-link.active")).toContain("box-shadow: inset 2px 0 0 var(--accent)");
});

test("log rows keep a minimal left gutter", async () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  expect(cssRule(css, ".log-entry")).toContain("padding: 2px 8px");
  expect(cssRule(css, ".log-time")).toContain("flex: 0 0 48px");
  expect(cssRule(css, ".log-continuation")).toContain("padding-left: 8px");
  const detail = cssRule(css, ".log-detail-lines");
  expect(detail).toContain("overflow: hidden");
  expect(detail).not.toContain("white-space: pre-wrap");
});

test("shared CSS tokens replace duplicated values and late overrides", () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  const root = cssRule(css, ":root");
  for (const token of [
    "--card-radius: 10px",
    "--log-bg: #161c29",
    "--log-row-border: rgba(46, 58, 82, 0.3)",
    "--log-max-height: 560px",
    "--stage-fg: #c4b5fd",
    "--stage-bg: rgba(167, 139, 250, 0.16)",
  ]) expect(root).toContain(token);
  expect(cssRule(css, ".log-viewer")).toContain("background: var(--log-bg)");
  expect(cssRule(css, ".log-viewer")).toContain("max-height: var(--log-max-height)");
  expect(cssRule(css, ".log-entry")).toContain("border-bottom: 1px solid var(--log-row-border)");
  expect(cssRule(css, "#errorCards")).toContain("max-height: var(--log-max-height)");
  expect(cssRule(css, ".log-stage")).toContain("background: var(--stage-bg)");
  expect(cssRule(css, ".log-stage")).toContain("color: var(--stage-fg)");
  expect(cssRule(css, ".stage-badge")).toContain("background: var(--stage-bg)");
  expect(cssRule(css, ".stage-badge")).toContain("color: var(--stage-fg)");
  for (const selector of [".job-card", ".error-card", ".progress-panel"]) {
    expect(cssRule(css, selector)).toContain("border-radius: var(--card-radius)");
  }
  expect(cssRule(css, ".modal-overlay")).toContain("z-index: 200");
  expect(css.match(/^\.modal-overlay \{/gm)).toHaveLength(1);
  expect(css.match(/^:focus-visible \{/gm)).toHaveLength(1);
  for (const rule of [".setting-label", ".setting-value", ".setting-key"]) {
    expect(css.match(new RegExp(`^\\${rule} \\{`, "gm"))).toHaveLength(1);
  }
  expect(cssRule(css, ".setting-label")).toContain("font-size: 12px");
  expect(cssRule(css, ".setting-label")).toContain("color: var(--text)");
  expect(cssRule(css, ".setting-value")).toContain("font-size: 12px");
  expect(cssRule(css, ".setting-key")).toContain("font-size: 10px");
});

test("archive cards keep their header inline and show retry and cooldown chips", async () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "styles.css"), "utf8");
  expect(cssRule(css, ".job-card-head")).not.toContain("justify-content: space-between");
  expect(cssRule(css, ".error-card-head")).not.toContain("justify-content: space-between");
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
