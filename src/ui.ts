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
): HeadersInit {
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
    requestAnimationFrame(function () { el.classList.add("show"); });
    window.setTimeout(function () { el.classList.remove("show"); }, 3200);
    window.setTimeout(function () { el.remove(); }, 3600);
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

  function mark(button, busy) {
    button.disabled = busy;
    button.classList.toggle("is-loading", busy);
  }

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

  document.body.addEventListener("appToast", function (event) {
    var detail = event.detail || {};
    if (typeof detail === "string") { toast(detail, "ok"); return; }
    toast(detail.message || "", detail.kind || "ok");
  });

  function showModal(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.hidden = false;
    var first = overlay.querySelector("button");
    if (first) first.focus();
  }
  function hideModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < overlays.length; i++) overlays[i].hidden = true;
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
      <button type="button" class="btn danger" hx-post="/run/stop" hx-vals='{"mode":"soft"}' hx-target="#controls" hx-swap="outerHTML" data-modal-close>Soft stop</button>
      <button type="button" class="btn danger solid" hx-post="/run/stop" hx-vals='{"mode":"hard"}' hx-target="#controls" hx-swap="outerHTML" data-modal-close>Hard stop</button>
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
var stored = localStorage.getItem("rail-open");
setRail(isMobile ? false : stored !== "0");

btn.addEventListener("click", function () {
  setRail(!bodyEl.classList.contains("rail-open"));
  localStorage.setItem("rail-open", bodyEl.classList.contains("rail-open") ? "1" : "0");
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
<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
<link rel="stylesheet" href="/public/styles.css">
<script src="/public/htmx.min.js" defer></script>
</head>
<body>
${railHtml}
<main class="content">
<h1 class="page-title">${esc(title)}</h1>
${body}
</main>
<div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
${active !== "" ? MODALS : ""}
${GLOBAL_SCRIPT}
${script}
</body>
</html>`;
}
