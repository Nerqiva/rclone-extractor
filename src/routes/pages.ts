import { Hono } from "hono";
import { readdirSync, statSync, existsSync } from "node:fs";
import { layout, esc } from "../ui";
import { configForm } from "./actions";
import { LOG_DIR } from "../config";

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

pages.get("/config", (c) => {
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <form method="post" action="/export">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include rclone.conf</label>
      <button class="btn" type="submit">Export .tar.gz</button>
    </form>
    <form style="margin-top:14px" method="post" action="/import" enctype="multipart/form-data">
      <label class="field"><span>Import backup</span><input type="file" name="archive" accept=".gz,.tgz"></label>
      <button class="btn danger" type="submit">Import (replaces DB)</button>
    </form>
  </div>`;
  return c.html(layout("Configuration", configForm() + extra, "config"));
});

pages.get("/logs", (c) => {
  const files = existsSync(LOG_DIR)
    ? readdirSync(LOG_DIR)
        .filter((f) => /^run-.*\.log$/.test(f))
        .map((f) => ({
          name: f,
          mtime: new Date(statSync(`${LOG_DIR}/${f}`).mtimeMs).toISOString(),
        }))
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    : [];
  const idOf = (name: string) => {
    const m = name.match(/^run-(\d+)-/);
    return m ? m[1] : "0";
  };
  const list = files.length
    ? files
        .map(
          (f) =>
            `<tr><td>${esc(f.name)}</td><td class="muted">${esc(f.mtime)}</td>
        <td><a href="/download/run/${idOf(f.name)}">download</a></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No runs yet.</td></tr>`;

  const body = `<div hx-get="/logs/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
      <p class="muted">Loading…</p>
    </div>
    <h2 class="section-title">Previous runs</h2>
    <table><thead><tr><th>File</th><th>Modified</th><th></th></tr></thead>
    <tbody>${list}</tbody></table>`;
  return c.html(layout("Logs", body, "logs"));
});

pages.get("/errors", (c) => {
  const body = `<table>
    <thead><tr><th>Archive</th><th>Kind</th><th>Updated</th><th></th></tr></thead>
    <tbody hx-get="/errors/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML">
      <tr><td colspan="4" class="muted">Loading…</td></tr>
    </tbody></table>`;
  return c.html(layout("Errors", body, "errors"));
});
