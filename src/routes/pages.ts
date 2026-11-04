import { Hono } from "hono";
import { store } from "../db";
import { layout, esc } from "../ui";
import { configForm } from "./actions";
import { encryptionEnabled } from "../crypto";

export const pages = new Hono();

pages.get("/", (c) =>
  c.html(
    layout(
      "Dashboard",
      `<div hx-get="/dashboard/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
        <p class="muted">Loading…</p>
      </div>
      <div id="controls" hx-get="/dashboard/controls" hx-trigger="load" hx-swap="outerHTML"></div>`,
      "dashboard",
    ),
  ),
);

pages.get("/config", async (c) => {
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <form method="post" action="/export">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include secrets (rclone.conf, password, database_url)</label>
      <button class="btn" type="submit">Export JSON</button>
    </form>
    <form style="margin-top:14px" method="post" action="/import" enctype="multipart/form-data">
      <label class="field"><span>Import backup (.json)</span><input type="file" name="archive" accept=".json"></label>
      <button class="btn danger" type="submit">Import (replaces data)</button>
    </form>
    ${
      encryptionEnabled()
        ? ""
        : `<p class="muted">Set the <code>SECRET_KEY</code> env var to encrypt stored secrets.</p>`
    }
  </div>`;
  return c.html(layout("Configuration", (await configForm()) + extra, "config"));
});

pages.get("/logs", async (c) => {
  const runs = await store.query<{ id: number; started_at: string; finished_at: string | null }>(
    "SELECT id, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 50",
  );
  const list = runs.length
    ? runs
        .map(
          (r) =>
            `<tr><td>run ${r.id}</td><td class="muted">${esc(r.started_at)}</td>
        <td class="muted">${esc(r.finished_at ?? "in progress")}</td>
        <td><a href="/download/run/${r.id}">download</a></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="muted">No runs yet.</td></tr>`;

  const body = `<div hx-get="/logs/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
      <p class="muted">Loading…</p>
    </div>
    <h2 class="section-title">Previous runs</h2>
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Started</th><th>Finished</th><th></th></tr></thead>
    <tbody>${list}</tbody></table></div>`;
  return c.html(layout("Logs", body, "logs"));
});

pages.get("/errors", (c) => {
  const body = `<div class="table-wrap"><table>
      <thead><tr><th>Archive</th><th>Kind</th><th>Updated</th><th></th></tr></thead>
      <tbody hx-get="/errors/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML">
        <tr><td colspan="4" class="muted">Loading…</td></tr>
      </tbody></table></div>`;
  return c.html(layout("Errors", body, "errors"));
});
