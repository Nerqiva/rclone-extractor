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
    var trigger = elt.getAttribute && elt.getAttribute("hx-trigger");
    if (trigger && trigger.indexOf("every") !== -1) return [];
    if (elt.matches && elt.matches("button.btn")) return [elt];
    return Array.prototype.slice.call(elt.querySelectorAll("button.btn"));
  }

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

  document.body.addEventListener("click", function (event) {
    var btn = event.target.closest ? event.target.closest(".btn") : null;
    if (!btn) return;
    if (btn.getAttribute("type") === "submit") return;
    var cfm = btn.closest("[data-confirm]");
    if (cfm && !cfm.hasAttribute("data-confirmed")) return;
    if (btn.id === "confirm-ok" || btn.disabled) return;
    if (btn.getAttribute("aria-disabled") === "true") return;
    if (btn.closest("[data-modal-open], [data-modal-close], [data-edit], [data-cancel]")) return;
    var trg = btn.getAttribute("hx-trigger");
    if (trg && trg.indexOf("every") !== -1) return;
    mark(btn, true);
  }, true);

  document.body.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.querySelector) return;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) mark(btn, true);
  }, true);

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
    var buttons = overlay.querySelectorAll(".modal-actions button");
    var benign = buttons[buttons.length - 1] || overlay.querySelector("button");
    if (benign) benign.focus();
  }
  function hideModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < overlays.length; i++) overlays[i].hidden = true;
    pendingConfirm = null;
    if (lastOpener && document.contains(lastOpener) && lastOpener.focus) {
      lastOpener.focus();
    }
    lastOpener = null;
  }

  var pendingConfirm = null;

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

  // Queue visibility lives in the DOM outside #dashboard-panel, which is
  // swapped every second. The controls fragment is replaced on that same
  // tick, so re-sync its toggle label after a swap and on the refresh timer.
  function queuePanel() { return document.getElementById("queuePanel"); }
  function syncQueueButtons() {
    var panel = queuePanel();
    if (!panel) return;
    var toggles = document.querySelectorAll("[data-queue-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      var btn = toggles[i];
      var hidden = panel.hidden;
      btn.textContent = (hidden ? "Show Queue (" : "Hide Queue (") +
        (btn.getAttribute("data-queue-count") || "0") + ")";
      btn.setAttribute("aria-expanded", hidden ? "false" : "true");
    }
  }
  function loadQueue(page, quiet) {
    var body = document.getElementById("queuePanelBody");
    if (!body) return;
    body.setAttribute("data-page", String(page));
    if (!quiet) body.innerHTML = '<p class="muted">Loading…</p>';
    fetch("/dashboard/queue?page=" + encodeURIComponent(String(page)), {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(function (response) { return response.ok ? response.text() : ""; })
      .then(function (html) {
        body.innerHTML = html || '<p class="muted">Could not load the queue.</p>';
      })
      .catch(function () {
        body.innerHTML = '<p class="muted">Could not load the queue.</p>';
      });
  }
  function queueRefresh() {
    var panel = queuePanel();
    var body = document.getElementById("queuePanelBody");
    if (!panel || panel.hidden || !body || document.hidden) return;
    syncQueueButtons();
    loadQueue(Number(body.getAttribute("data-page") || "1"), true);
  }
  document.body.addEventListener("click", function (event) {
    var toggle = event.target.closest ? event.target.closest("[data-queue-toggle]") : null;
    if (toggle) {
      var panel = queuePanel();
      if (!panel) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) loadQueue(1);
      syncQueueButtons();
      if (window.appUnmark) window.appUnmark(toggle);
      return;
    }
    var pager = event.target.closest ? event.target.closest("[data-queue-page]") : null;
    if (pager) {
      // The global busy handler disables .btn in the capture phase, so do not
      // gate on disabled here; the server clamps the requested page anyway.
      loadQueue(Number(pager.getAttribute("data-queue-page")));
      if (window.appUnmark) window.appUnmark(pager);
    }
  });
  document.body.addEventListener("htmx:afterSwap", function (event) {
    var target = event.detail && event.detail.target;
    if (target && target.id === "controls") syncQueueButtons();
  });
  syncQueueButtons();
  if (queuePanel()) window.setInterval(queueRefresh, 3000);
})();
</script>`;

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
