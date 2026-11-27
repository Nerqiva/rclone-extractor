import { APP_TZ } from "./config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Cache buster for /public/* assets: HTML is no-store, but browsers apply
// heuristic caching to the stylesheet/scripts, which once served a stale
// pre-tooltip stylesheet next to fresh HTML. The release-bumped VERSION
// changes the URL on every deploy; /public/* itself revalidates (server.ts).
const APP_VERSION = readFileSync(
  join(import.meta.dir, "..", "VERSION"),
  "utf8",
).trim();
export function asset(name: string): string {
  return `/public/${name}?v=${APP_VERSION}`;
}

function sanitizeToast(message: string): string {
  return message
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
    .trim();
}

export function toastTriggerHeaders(
  message: string,
  kind: "ok" | "err" = "ok",
): Record<string, string> {
  return {
    "HX-Trigger": JSON.stringify({ appToast: { message: sanitizeToast(message), kind } }),
  };
}

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export function fmtDisplayTime(iso: string, withDate = false): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return (withDate ? DATE_TIME_FMT : TIME_FMT).format(new Date(t));
}

let infoTipSeq = 0;

/**
 * Superscript "(i)" indicator rendered with its tooltip bubble. Hover or
 * keyboard focus reveals it (CSS), tapping toggles it (global script in
 * layout()). `tip` is the full description shown to mouse/touch users;
 * `label` names the thing for screen readers ("More info: <label>").
 */
export function info(tip: string, label: string): string {
  const id = `info-tip-${++infoTipSeq}`;
  return `<span class="info-tip"><button type="button" class="info-i" aria-expanded="false" aria-describedby="${id}" aria-label="More info: ${esc(label)}">i</button><span class="info-tip-bubble" role="tooltip" id="${id}">${esc(tip)}</span></span>`;
}

const MODALS = `<div class="modal-overlay" id="stop-modal" hidden role="dialog" aria-modal="true" aria-label="Stop">
  <div class="modal-card">
    <div class="modal-actions">
      <!-- hx-swap="none" swaps nothing but still runs the stop request and
           the HX-Trigger toast on every page (incl. those without #controls);
           the polling controls refresh themselves on the next tick. -->
      <button type="button" class="btn danger" hx-post="/run/stop" hx-vals='{"mode":"soft"}' hx-target="body" hx-swap="none" data-modal-close>Soft stop</button>
      <button type="button" class="btn danger solid" hx-post="/run/stop" hx-vals='{"mode":"hard"}' hx-target="body" hx-swap="none" data-modal-close>Hard stop</button>
      <button type="button" class="btn ghost" data-modal-close>Cancel</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="confirm-modal" hidden role="dialog" aria-modal="true" aria-label="Confirm">
  <div class="modal-card">
    <h2 class="modal-title" id="confirm-modal-title">Confirm</h2>
    <div class="modal-actions">
      <button type="button" class="btn danger" id="confirm-ok">Confirm</button>
      <button type="button" class="btn" data-modal-close>Cancel</button>
    </div>
  </div>
</div>`;

const NAV: { href: string; label: string; key: string; icon: string }[] = [
  {
    href: "/",
    label: "Progress",
    key: "dashboard",
    icon: `<polyline points="3 12 8 12 11 5 14 19 17 12 21 12"/>`,
  },
  {
    href: "/config",
    label: "Configuration",
    key: "config",
    icon: `<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.1" fill="#242d40"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.1" fill="#242d40"/>`,
  },
  {
    href: "/logs",
    label: "Logs",
    key: "logs",
    icon: `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
  },
  {
    href: "/errors",
    label: "Errors",
    key: "errors",
    icon: `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  },
];

const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 64 64" width="26" height="26" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="14" fill="#242d40" stroke="#2e3a52" stroke-width="3"/><text x="31" y="44" text-anchor="middle" font-family="ui-monospace, JetBrains Mono, Menlo, monospace" font-weight="700" font-size="32"><tspan fill="#6f9bff">r</tspan><tspan fill="#cdd6f4">/</tspan></text></svg>`;

function rail(active: string, csrf: string | null = null): string {
  const links = NAV.map(
    (n) => `<a class="nav-link${n.key === active ? " active" : ""}" href="${n.href}"${
      n.key === active ? ' aria-current="page"' : ""
    }><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n.icon}</svg><span>${esc(n.label)}</span></a>`,
  ).join("");
  const csrfInput = csrf
    ? `<input type="hidden" name="csrf_token" value="${esc(csrf)}">`
    : "";
  return `<aside class="rail" id="rail">
    <a class="brand" href="/" aria-label="rclone-extractor home">${BRAND_MARK}<span class="brand-word">rclone<span class="brand-slash">/</span>extractor</span></a>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="rail-foot">
      <div class="rail-status">
        <span class="dot" aria-hidden="true"></span>
        <span class="dot-label">authed</span>
      </div>
      <form method="post" action="/logout" class="rail-logout">
        ${csrfInput}
        <button class="btn small rail-btn" type="submit">Sign out</button>
      </form>
    </div>
  </aside>`;
}

export function layout(
  title: string,
  body: string,
  active = "",
  csrf: string | null = null,
  subtitle = "",
): string {
  const railHtml = active !== "" ? `<button class="rail-toggle" id="rail-toggle" aria-label="Toggle navigation" aria-controls="rail" aria-expanded="false"><span></span><span></span><span></span></button>${rail(active, csrf)}<div class="rail-overlay" id="rail-overlay"></div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csrf ? `<meta name="csrf-token" content="${esc(csrf)}">` : ""}
<title>${esc(title)} · rclone-extractor</title>
<link rel="icon" type="image/svg+xml" href="${asset("favicon.svg")}">
<link rel="stylesheet" href="${asset("styles.css")}">
<script src="${asset("htmx.min.js")}" defer></script>
<script src="${asset("app.js")}" defer></script>
</head>
<body>
${railHtml}
<main class="content">
<h1 class="page-title">${esc(title)}</h1>
${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ""}
${body}
</main>
<div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
${active !== "" ? MODALS : ""}
</body>
</html>`;
}
