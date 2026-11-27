import { test, expect } from "bun:test";
import {
  emptyState,
  indeterminateBar,
  logActions,
  minibar,
  pill,
  retryBadge,
  stageBadge,
  statusBadge,
} from "../src/cardui";

test("log actions share one fold, copy button and download link", () => {
  const html = logActions({
    id: "7",
    name: "a.zip",
    logId: "ar-log-7",
    copyHref: "/download/archive/7?kind=extract",
    downloadHref: "/download/archive/7",
  });
  expect(html.match(/data-log-toggle="7"/g)).toHaveLength(1);
  expect(html).toContain('aria-controls="ar-log-7"');
  expect(html).toContain('data-copy-url="/download/archive/7?kind=extract"');
  expect(html).toContain('href="/download/archive/7"');
  expect(html).toContain(">Copy log</button>");
  expect(html).toContain(">Download</a>");
});

test("card chips and bars use the shared markup", () => {
  expect(emptyState("<p>None</p>")).toBe('<div class="empty-state"><p>None</p></div>');
  expect(pill("done", "ok")).toBe('<span class="pill ok">done</span>');
  expect(pill("queued")).toBe('<span class="pill">queued</span>');
  expect(statusBadge("Extracting", "is-running")).toContain("status-badge is-running");
  expect(stageBadge("Extracting")).toContain("failed at Extracting");
  expect(minibar("a.zip", 42.5)).toContain('aria-valuenow="43"');
  expect(minibar("a.zip", null)).toContain('aria-valuenow="0"');
  expect(indeterminateBar("a.zip", "Working")).toContain("minibar is-indeterminate");
  expect(retryBadge(1, 0)).toBe("");
  expect(retryBadge(2, Date.now() + 5000)).toContain("retry 1/");
  expect(retryBadge(2, Date.now() + 5000)).toContain("cooldown");
  expect(retryBadge(4, 0, true)).toContain("on its 3rd retry");
});
