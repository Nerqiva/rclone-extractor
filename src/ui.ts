export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAV: { href: string; label: string; key: string }[] = [
  { href: "/", label: "Dashboard", key: "dashboard" },
  { href: "/config", label: "Configuration", key: "config" },
  { href: "/logs", label: "Logs", key: "logs" },
  { href: "/errors", label: "Errors", key: "errors" },
];

export function rail(active: string): string {
  const links = NAV.map(
    (n) =>
      `<a class="nav-link${n.key === active ? " active" : ""}" href="${n.href}">${esc(
        n.label,
      )}</a>`,
  ).join("");
  return `<aside class="rail" id="rail">
    <div class="brand">rclone<span>/</span>extractor</div>
    <nav class="nav">${links}</nav>
    <div class="rail-foot">
      <span class="dot" id="status-dot" title="status"></span>
      <span class="dot-label">authed</span>
      <form method="post" action="/logout" class="rail-logout">
        <button class="btn" type="submit">Sign out</button>
      </form>
    </div>
  </aside>`;
}

export function layout(
  title: string,
  body: string,
  active = "",
): string {
  const railHtml = active !== "" ? `<button class="rail-toggle" id="rail-toggle" aria-label="Toggle navigation" aria-controls="rail" aria-expanded="false"><span></span><span></span><span></span></button>${rail(active)}<div class="rail-overlay" id="rail-overlay"></div>` : "";
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
${script}
</body>
</html>`;
}
