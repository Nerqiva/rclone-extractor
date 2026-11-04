import { Hono } from "hono";
import { store, setSetting, allSettings, getSetting } from "../db";
import { engineState, runEngine, stopEngine } from "../engine";
import { esc } from "../ui";
import { encryptionEnabled } from "../crypto";
import { APP_PASSWORD } from "../config";

export const actions = new Hono();

export function controlsFragment(): string {
  const running = engineState.running;
  return `<div id="controls" class="btn-row">
    ${
      running
        ? `<button class="btn danger" hx-post="/run/stop" hx-target="#controls" hx-swap="outerHTML">Stop</button>
           <span class="muted">run in progress…</span>`
        : `<button class="btn primary" hx-post="/run/start" hx-target="#controls" hx-swap="outerHTML">Start</button>`
    }
  </div>`;
}

actions.post("/run/start", async (c) => {
  if (!engineState.running) {
    await store.run("UPDATE archives SET status='queued' WHERE status='failed'");
    await setSetting("cancel", "0");
    void runEngine();
  }
  return c.html(controlsFragment());
});

actions.post("/run/stop", async (c) => {
  stopEngine();
  return c.html(controlsFragment());
});

const SETTING_KEYS = [
  "scan_root",
  "remote_flags",
  "queue_max",
  "sort_by",
  "sort_dir",
  "trash_subdir",
  "password",
];

actions.post("/config", async (c) => {
  const form = await c.req.formData();
  for (const key of SETTING_KEYS) {
    const value = form.get(key);
    if (value !== null) await setSetting(key, String(value));
  }
  await setSetting("dry_run", form.get("dry_run") !== null ? "1" : "0");
  await setSetting("resume", form.get("resume") !== null ? "1" : "0");
  return c.html(await configForm(`<p class="note">Saved.</p>`));
});

actions.post("/rclone-conf", async (c) => {
  const body = await c.req.text();
  await setSetting("rclone_conf", body);
  return c.html(`<p class="note">Stored rclone.conf (${esc(body.length)} bytes).</p>`);
});

export async function configForm(note = ""): Promise<string> {
  const s = await allSettings();
  const sel = (v: string, o: string) => (v === o ? " selected" : "");
  const backend = store.backend();
  const enc = encryptionEnabled();
  const appPassword = await getSetting("password", "");
  const pwWorks = appPassword ? "set" : APP_PASSWORD ? "from env" : "not set";
  return `<form class="card" hx-post="/config" hx-target="#config-form" hx-swap="innerHTML" id="config-form">
  ${note}
  <p class="muted">
    Backend: <strong>${esc(backend)}</strong>
    &middot; Encryption: <strong>${enc ? "on" : "off"}</strong>
    <span class="pill ${pwWorks === "not set" ? "err" : "ok"}">password ${esc(pwWorks)}</span>
  </p>
  <label class="field"><span>scan_root</span>
    <input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path"></label>
  <label class="field"><span>remote_flags</span>
    <input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--config /data/rclone.conf"></label>
  <label class="field"><span>database_url (read-only; set the DATABASE_URL env var and restart to switch)</span>
    <input type="text" name="database_url" value="${esc(s.database_url ?? "")}" placeholder="postgres://user:pass@host:5432/db?sslmode=require" readonly disabled></label>
  <div class="field-row" style="display:flex;gap:14px;flex-wrap:wrap">
    <label class="field" style="flex:1"><span>queue_max</span>
      <input type="number" name="queue_max" value="${esc(s.queue_max ?? "500")}"></label>
    <label class="field" style="flex:1"><span>trash_subdir</span>
      <input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}"></label>
  </div>
  <div class="field-row" style="display:flex;gap:14px;flex-wrap:wrap">
    <label class="field" style="flex:1"><span>sort_by</span>
      <select name="sort_by">
        <option value="path"${sel(s.sort_by ?? "path", "path")}>path</option>
        <option value="size"${sel(s.sort_by ?? "path", "size")}>size</option>
      </select></label>
    <label class="field" style="flex:1"><span>sort_dir</span>
      <select name="sort_dir">
        <option value="asc"${sel(s.sort_dir ?? "asc", "asc")}>asc</option>
        <option value="desc"${sel(s.sort_dir ?? "asc", "desc")}>desc</option>
      </select></label>
  </div>
  <label class="field"><span>password</span>
    <input type="text" name="password" value="${esc(s.password ?? "")}"></label>
  <label class="check"><input type="checkbox" name="dry_run"${s.dry_run === "1" ? " checked" : ""}> dry_run</label>
  <label class="check"><input type="checkbox" name="resume"${s.resume === "1" ? " checked" : ""}> Continue previous task (resume after crash/failure)</label>
  <div class="btn-row">
    <button class="btn primary" type="submit">Save</button>
  </div>
</form>`;
}
