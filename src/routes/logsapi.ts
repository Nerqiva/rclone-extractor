import { Hono } from "hono";
import { store, getSetting } from "../db";
import { tail, readAll } from "../log";
import { esc } from "../ui";

export const logsapi = new Hono();

async function latestRunId(): Promise<number> {
  const setting = Number((await getSetting("last_run_id", "0")) ?? "0");
  if (setting > 0) return setting;
  const row = await store.get1<{ id: number }>("SELECT id FROM runs ORDER BY id DESC LIMIT 1");
  return Number(row?.id ?? 0);
}

logsapi.get("/logs/fragment", async (c) => {
  const runId = await latestRunId();
  if (!runId) return c.html(`<p class="muted">No runs yet.</p>`);
  const lines = await tail({ scope: "run", refId: runId, kind: "main" }, 200);
  if (lines.length === 0) return c.html(`<p class="muted">No runs yet.</p>`);
  return c.html(`<pre class="tail">${esc(lines.join("\n"))}</pre>`);
});

logsapi.get("/errors/fragment", async (c) => {
  const rows = await store.query<{
    id: number;
    path: string;
    error_kind: string;
    updated_at: string;
  }>(
    "SELECT id, path, error_kind, updated_at FROM archives WHERE error_kind IS NOT NULL ORDER BY updated_at DESC",
  );
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
  const lines = await readAll({ scope: "run", refId: id, kind: "main" });
  if (lines.length === 0) return c.text("not found", 404);
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="run-${id}.log"`,
    },
  });
});

logsapi.get("/download/archive/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const kind = c.req.query("kind") === "rclone" ? "rclone" : "extract";
  const lines = await readAll({ scope: "archive", refId: id, kind });
  if (lines.length === 0) return c.text("not found", 404);
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="archive-${id}-${kind}.log"`,
    },
  });
});
