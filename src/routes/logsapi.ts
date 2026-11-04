import { Hono } from "hono";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { db } from "../db";
import { LOG_DIR } from "../config";
import { esc } from "../ui";

export const logsapi = new Hono();

function runLogs(): { name: string; mtime: number }[] {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => /^run-.*\.log$/.test(f))
    .map((f) => ({ name: f, mtime: statSync(`${LOG_DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

logsapi.get("/logs/fragment", (c) => {
  const logs = runLogs();
  if (logs.length === 0) {
    return c.html(`<p class="muted">No runs yet.</p>`);
  }
  const latest = `${LOG_DIR}/${logs[0].name}`;
  const lines = readFileSync(latest, "utf8").split("\n");
  const tail = lines.slice(-200).join("\n");
  return c.html(`<pre class="tail">${esc(tail)}</pre>`);
});

logsapi.get("/errors/fragment", (c) => {
  const rows = db
    .query(
      "SELECT id, path, error_kind, updated_at FROM archives WHERE error_kind IS NOT NULL ORDER BY updated_at DESC",
    )
    .all() as {
    id: number;
    path: string;
    error_kind: string;
    updated_at: string;
  }[];
  if (rows.length === 0) {
    return c.html(`<tr><td colspan="4" class="muted">No errors.</td></tr>`);
  }
  const html = rows
    .map(
      (r) => `<tr>
      <td>${esc(r.path)}</td>
      <td><span class="pill warn">${esc(r.error_kind)}</span></td>
      <td class="muted">${esc(r.updated_at)}</td>
      <td><a href="/download/archive/${r.id}?kind=extract">extract log</a></td>
    </tr>`,
    )
    .join("");
  return c.html(html);
});

logsapi.get("/download/run/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const match = runLogs().find((l) => l.name.startsWith(`run-${id}-`));
  if (!match) return c.text("not found", 404);
  const path = `${LOG_DIR}/${match.name}`;
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${match.name}"`,
    },
  });
});

logsapi.get("/download/archive/:id", (c) => {
  const id = Number(c.req.param("id"));
  const kind = c.req.query("kind") === "rclone" ? "rclone" : "extract";
  const row = db
    .query("SELECT rel_path FROM logs WHERE archive_id=? AND kind=?")
    .get(id, kind) as { rel_path: string } | null;
  if (!row || !existsSync(row.rel_path)) return c.text("not found", 404);
  return new Response(Bun.file(row.rel_path), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="archive-${id}-${kind}.log"`,
    },
  });
});
