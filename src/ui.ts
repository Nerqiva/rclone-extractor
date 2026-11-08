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
})();
</script>`;

const NAV: { href: string; label: string; key: string }[] = [
  { href: "/", label: "Progress", key: "dashboard" },
  { href: "/config", label: "Configuration", key: "config" },
  { href: "/logs", label: "Logs", key: "logs" },
  { href: "/errors", label: "Errors", key: "errors" },
];

export function rail(active: string, csrf: string | null = null): string {
  const links = NAV.map(
    (n) =>
      `<a class="nav-link${n.key === active ? " active" : ""}" href="${n.href}">${esc(
        n.label,
      )}</a>`,
  ).join("");
  const csrfInput = csrf
    ? `<input type="hidden" name="csrf_token" value="${esc(csrf)}">`
    : "";
  return `<aside class="rail" id="rail">
    <div class="brand">rclone<span>/</span>extractor</div>
    <nav class="nav">${links}</nav>
    <div class="rail-foot">
      <span class="dot" id="status-dot" title="status"></span>
      <span class="dot-label">authed</span>
      <form method="post" action="/logout" class="rail-logout">
        ${csrfInput}
        <button class="btn" type="submit">Sign out</button>
      </form>
      <form method="post" action="/logout-all" class="rail-logout">
        ${csrfInput}
        <button class="btn ghost" type="submit" title="Revoke every session">Sign out everywhere</button>
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
${GLOBAL_SCRIPT}
${script}
</body>
</html>`;
}
