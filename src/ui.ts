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

/** Sanitize a message for an HX-Trigger appToast header (ASCII-safe). */
function sanitizeToast(message: string): string {
  return message
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/**
 * Headers asking htmx to show a toast. Use for both full-page fragment
 * responses and polled fragments.
 */
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

/**
 * Every time shown in the UI renders in the configured display timezone
 * (APP_TZ, default Asia/Omsk). The DB and backups stay in UTC. Falls back to
 * "—" for unparseable input. `withDate` includes the date (used for Ended/
 * Started); otherwise only the time is shown (used for log lines).
 */
export function fmtDisplayTime(iso: string, withDate = false): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const opts: Intl.DateTimeFormatOptions = withDate
    ? {
        timeZone: APP_TZ,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      }
    : {
        timeZone: APP_TZ,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      };
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(t));
}

// Unique ids for the tooltip spans, per render (process-wide counter keeps
// ids unique even when a fragment is swapped in and out).
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

// Shared toast + busy-state behaviour for every page. htmx buttons show a
// spinner and disable while their request is in flight; server responses
// toast through the HX-Trigger response header ({"appToast":{message,kind}}).
// `window.appToast(message, kind)` is also available for inline scripts.
const GLOBAL_SCRIPT = `<script>
(function () {
  "use strict";

  function toast(message, kind) {
    var region = document.getElementById("toast-region");
    if (!region) return;
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.textContent = message;
    region.appendChild(el);
    var lifetime = kind === "err" ? 8000 : 3200;
    requestAnimationFrame(function () { el.classList.add("show"); });
    window.setTimeout(function () { el.classList.remove("show"); }, lifetime);
    window.setTimeout(function () { el.remove(); }, lifetime + 400);
  }
  window.appToast = toast;

  function actionButtons(elt) {
    if (!elt || !elt.querySelectorAll) return [];
    // The controls fragment polls itself every second while stopping; those
    // polling requests must not flash the buttons as busy.
    var trigger = elt.getAttribute && elt.getAttribute("hx-trigger");
    if (trigger && trigger.indexOf("every") !== -1) return [];
    if (elt.matches && elt.matches("button.btn")) return [elt];
    return Array.prototype.slice.call(elt.querySelectorAll("button.btn"));
  }

  // Busy state for every action button, not just the ones that opted in
  // with a hand-placed .spinner: inject one when missing. htmx buttons are
  // marked from before/afterRequest; everything else from the global click
  // handler below, and completion paths call appUnmark. A 60s safety
  // timeout unmarks anything whose completion we missed.
  var BUSY_SAFETY_MS = 60000;

  function mark(button, busy) {
    if (!button) return;
    var isAnchor = button.tagName === "A";
    if (busy) {
      if (!isAnchor) button.disabled = true;
      button.classList.add("is-loading");
      if (!button.querySelector(".spinner")) {
        var sp = document.createElement("span");
        sp.className = "spinner";
        sp.setAttribute("aria-hidden", "true");
        sp.setAttribute("data-injected", "1");
        button.insertBefore(sp, button.firstChild);
      }
      if (button.dataset.busySafety) window.clearTimeout(Number(button.dataset.busySafety));
      button.dataset.busySafety = String(
        window.setTimeout(function () { mark(button, false); }, BUSY_SAFETY_MS),
      );
      return;
    }
    if (button.dataset.busySafety) {
      window.clearTimeout(Number(button.dataset.busySafety));
      delete button.dataset.busySafety;
    }
    if (!isAnchor) button.disabled = false;
    button.classList.remove("is-loading");
    var injected = button.querySelectorAll('.spinner[data-injected="1"]');
    for (var i = 0; i < injected.length; i++) injected[i].remove();
  }
  window.appUnmark = function (button) { mark(button, false); };

  document.body.addEventListener("htmx:configRequest", function (event) {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) {
      event.detail.headers["X-CSRF-Token"] = meta.content;
    }
  });
  document.body.addEventListener("htmx:beforeRequest", function (event) {
    actionButtons(event.detail && event.detail.elt).forEach(function (b) { mark(b, true); });
  });
  document.body.addEventListener("htmx:afterRequest", function (event) {
    actionButtons(event.detail && event.detail.elt).forEach(function (b) { mark(b, false); });
  });

  // Every action button shows a busy state on click, not only the ones the
  // caller remembers to mark. Polling controls, disabled buttons, the
  // confirm-modal opener click and the modal's own Confirm button are
  // exempt (the gated button shows the state once confirmed). Plain submit
  // buttons are marked on the form's submit event instead — disabling one
  // mid-click would cancel the submission.
  document.body.addEventListener("click", function (event) {
    var btn = event.target.closest ? event.target.closest(".btn") : null;
    if (!btn) return;
    if (btn.getAttribute("type") === "submit") return;
    var cfm = btn.closest("[data-confirm]");
    if (cfm && !cfm.hasAttribute("data-confirmed")) return;
    if (btn.id === "confirm-ok" || btn.disabled) return;
    if (btn.getAttribute("aria-disabled") === "true") return;
    // Buttons that only open/close UI (modals, inline editors) have no
    // completion path; marking them busy disabled them for 60 s.
    if (btn.closest("[data-modal-open], [data-modal-close], [data-edit], [data-cancel]")) return;
    var trg = btn.getAttribute("hx-trigger");
    if (trg && trg.indexOf("every") !== -1) return;
    mark(btn, true);
  }, true);

  // Plain form submits (login, logout, export/import): busy the submitting
  // button once the submit is dispatched — never before.
  document.body.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.querySelector) return;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) mark(btn, true);
  }, true);

  // Archive-file downloads: one at a time, app-wide. The server keeps a
  // registry of in-flight streams; while it reports activity every Download
  // button greys out and says so on click instead of queueing a second
  // stream of the same remote. The clicked one unmarks when it drains.
  function greyDownloads(active) {
    var els = document.querySelectorAll("[data-download-archive]");
    for (var i = 0; i < els.length; i++) {
      els[i].classList.toggle("is-download-disabled", active);
      els[i].setAttribute("aria-disabled", active ? "true" : "false");
      if (!active) mark(els[i], false);
    }
  }
  function pollDownloads() {
    if (document.hidden) return;
    fetch("/download/archive-file/active", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.active === "number") greyDownloads(j.active > 0); })
      .catch(function () { /* transient; next tick retries */ });
  }
  document.body.addEventListener("click", function (event) {
    var el = event.target.closest ? event.target.closest("[data-download-archive]") : null;
    if (!el) return;
    if (el.classList.contains("is-download-disabled")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("A download is already in progress; wait for it to finish.", "err");
      return;
    }
    mark(el, true);
    window.setTimeout(pollDownloads, 200);
    window.setTimeout(pollDownloads, 1500);
  }, true);
  if (document.querySelector("[data-download-archive]")) {
    pollDownloads();
    window.setInterval(pollDownloads, 1500);
  }

  document.body.addEventListener("appToast", function (event) {
    var detail = event.detail || {};
    if (typeof detail === "string") { toast(detail, "ok"); return; }
    toast(detail.message || "", detail.kind || "ok");
  });

  // Superscript "(i)" info indicators: tap toggles the tooltip (touch
  // devices); Escape or a tap elsewhere closes it; scroll closes it too
  // (touch tooltips shouldn't float over new content). Hover/focus styling
  // is handled in CSS, so desktop needs no JS at all. The bubble flips
  // above the button when it would fall off the bottom of the viewport.
  function closeInfoTips() {
    var open = document.querySelectorAll(".info-tip.open");
    for (var i = 0; i < open.length; i++) {
      var btn = open[i].querySelector(".info-i");
      if (btn) btn.setAttribute("aria-expanded", "false");
      open[i].classList.remove("open");
    }
  }
  document.body.addEventListener("click", function (event) {
    var tip = event.target.closest ? event.target.closest(".info-i") : null;
    if (!tip) {
      closeInfoTips();
      return;
    }
    // Keep a tap from activating the surrounding label/button.
    event.preventDefault();
    event.stopPropagation();
    var wrap = tip.closest(".info-tip");
    var wasOpen = wrap.classList.contains("open");
    closeInfoTips();
    if (!wasOpen) {
      wrap.classList.add("open");
      tip.setAttribute("aria-expanded", "true");
      var bubble = wrap.querySelector(".info-tip-bubble");
      var button = tip.getBoundingClientRect();
      if (bubble) {
        var needed = bubble.offsetHeight + 12;
        if (button.bottom + needed > window.innerHeight) {
          wrap.classList.add("flip");
        } else {
          wrap.classList.remove("flip");
        }
      }
    }
  }, true);
  window.addEventListener("scroll", closeInfoTips, true);
  // Polled fragments (progress panel, controls, the Archives tab) swap every
  // 1–2 s, which would wipe an open info tooltip mid-read. Skip the swap
  // while one is showing inside it; it resumes when the tooltip closes.
  // In addition: when a polled fragment re-renders to the exact bytes it
  // already shows, skip the swap — identical polls would only throw away
  // focus, open log views and an in-flight click. Live fragments (elapsed
  // timers) still swap as before.
  var pollHtml = window.__pollHtml || (window.__pollHtml = {});
  document.body.addEventListener("htmx:beforeSwap", function (event) {
    var target = event.detail && event.detail.target;
    if (!target) return;
    if (target.querySelector && target.querySelector(".info-tip.open")) {
      event.preventDefault();
      return;
    }
    var elt = event.detail.elt;
    var trigger = elt && elt.getAttribute ? elt.getAttribute("hx-trigger") : null;
    if (!trigger || trigger.indexOf("every") === -1) return;
    var id = target.id || (elt && elt.id) || "";
    if (!id) return;
    var response = typeof event.detail.serverResponse === "string" ? event.detail.serverResponse : "";
    if (pollHtml[id] === response) {
      event.preventDefault();
      return;
    }
    pollHtml[id] = response;
  });
  // A page restored from the back-forward cache can show a stale run state
  // (e.g. an old Stop button). Re-fetch fresh instead.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeInfoTips();
  });

  var lastOpener = null;
  function showModal(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    lastOpener = document.activeElement;
    overlay.hidden = false;
    // Focus the benign choice (both modals end with Cancel), never the
    // destructive default.
    var buttons = overlay.querySelectorAll(".modal-actions button");
    var benign = buttons[buttons.length - 1] || overlay.querySelector("button");
    if (benign) benign.focus();
  }
  function hideModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < overlays.length; i++) overlays[i].hidden = true;
    // A stale confirmed button or opener must not survive an Escape close.
    pendingConfirm = null;
    if (lastOpener && document.contains(lastOpener) && lastOpener.focus) {
      lastOpener.focus();
    }
    lastOpener = null;
  }

  var pendingConfirm = null;

  // data-modal-open opens a named modal; data-modal-close and backdrop
  // clicks dismiss any modal. [data-confirm] buttons are htmx buttons that
  // must first pass through the shared confirm modal: intercept the click in
  // the capture phase (so htmx never sees it), then re-dispatch once the
  // user confirms.
  document.body.addEventListener("click", function (event) {
    var open = event.target.closest("[data-modal-open]");
    if (open) {
      event.preventDefault();
      showModal(open.getAttribute("data-modal-open"));
      return;
    }
    if (event.target.closest("[data-modal-close]") || event.target.classList.contains("modal-overlay")) {
      hideModals();
      return;
    }
    var cfm = event.target.closest("[data-confirm]");
    if (cfm && !cfm.hasAttribute("data-confirmed")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingConfirm = cfm;
      var title = document.getElementById("confirm-modal-title");
      var ok = document.getElementById("confirm-ok");
      var parts = String(cfm.getAttribute("data-confirm") || "|").split("|");
      if (title) title.textContent = parts[0] || "Confirm";
      if (ok) ok.textContent = parts[1] || "Confirm";
      showModal("confirm-modal");
    }
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideModals();
    if (event.key !== "Tab") return;
    var open = document.querySelector(".modal-overlay:not([hidden])");
    if (!open) return;
    var focusables = open.querySelectorAll(
      "button, [href], input, select, textarea",
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.body.addEventListener("click", function (event) {
    if (event.target.id !== "confirm-ok") return;
    if (!pendingConfirm) { hideModals(); return; }
    var btn = pendingConfirm;
    pendingConfirm = null;
    btn.setAttribute("data-confirmed", "1");
    hideModals();
    btn.click();
    btn.removeAttribute("data-confirmed");
  });
})();
</script>`;

// Shared modals injected on every authenticated page. The stop modal offers
// soft (current archive finishes) and hard (abort now) stop with no explanatory
// text; the confirm modal is the generic guard for destructive actions.
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

export function rail(active: string, csrf: string | null = null): string {
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
  const script = active !== "" ? `<script>
var btn = document.getElementById("rail-toggle");
var overlay = document.getElementById("rail-overlay");
var bodyEl = document.body;

function setRail(open) {
  bodyEl.classList.toggle("rail-open", open);
  btn.setAttribute("aria-expanded", String(open));
}

var isMobile = window.matchMedia("(max-width: 719px)").matches;
var stored = null;
try { stored = localStorage.getItem("rail-open"); } catch (e) { stored = null; }
setRail(isMobile ? false : stored !== "0");

btn.addEventListener("click", function () {
  setRail(!bodyEl.classList.contains("rail-open"));
  try { localStorage.setItem("rail-open", bodyEl.classList.contains("rail-open") ? "1" : "0"); } catch (e) {}
});
overlay.addEventListener("click", function () {
  setRail(false);
});
</script>` : "";
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
${GLOBAL_SCRIPT}
${script}
</body>
</html>`;
}
