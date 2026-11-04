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
  return `<aside class="rail">
    <div class="brand">rclone<span>/</span>extractor</div>
    <nav class="nav">${links}</nav>
    <div class="rail-foot">
      <span class="dot" id="status-dot" title="status"></span>
      <span class="dot-label">authed</span>
    </div>
  </aside>`;
}

export function layout(
  title: string,
  body: string,
  active = "",
): string {
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
${rail(active)}
<main class="content">
<h1 class="page-title">${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}
