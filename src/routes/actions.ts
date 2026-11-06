import { Hono } from "hono";
import { store, setSetting, allSettings, getSetting } from "../db";
import { engineState, runEngine, stopEngine } from "../engine";
import { esc } from "../ui";
import { encryptionEnabled } from "../crypto";
import { APP_PASSWORD, RCLONE_CONF } from "../config";
import { normalizeRcloneConf } from "../rcloneconf";

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
  "rclone_conf",
  "queue_max",
  "sort_by",
  "sort_dir",
  "trash_subdir",
  "password",
];

actions.post("/config", async (c) => {
  const form = await c.req.formData();

  const confField = form.get("rclone_conf");
  let normalizedConf: string | null = null;
  if (confField !== null) {
    const parsed = normalizeRcloneConf(String(confField));
    if (!parsed.ok) {
      return c.html(
        await configForm(`<p class="note err">rclone_conf: ${esc(parsed.error)}</p>`),
      );
    }
    normalizedConf = parsed.base64;
  }

  for (const key of SETTING_KEYS) {
    if (key === "rclone_conf") continue;
    const value = form.get(key);
    if (value !== null) await setSetting(key, String(value));
  }
  if (normalizedConf !== null) await setSetting("rclone_conf", normalizedConf);
  await setSetting("dry_run", form.get("dry_run") !== null ? "1" : "0");
  await setSetting("resume", form.get("resume") !== null ? "1" : "0");
  return c.html(await configForm(`<p class="note">Saved.</p>`));
});

actions.post("/rclone-conf", async (c) => {
  const body = await c.req.text();
  const parsed = normalizeRcloneConf(body);
  if (!parsed.ok) return c.text(parsed.error, 400);
  await setSetting("rclone_conf", parsed.base64);
  return c.html(
    `<p class="note">Stored rclone.conf (${esc(Buffer.byteLength(parsed.text, "utf8"))} bytes).</p>`,
  );
});

function settingRow(
  label: string,
  value: string,
  editor: string,
  opts: { unset?: boolean } = {},
): string {
  return `<div class="setting">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">${esc(label)}</span>
        <span class="setting-value${opts.unset ? " unset" : ""}">${esc(value)}</span>
      </div>
      <button type="button" class="btn small" data-edit>Edit</button>
    </div>
    <div class="setting-editor">
      ${editor}
      <div class="btn-row">
        <button class="btn primary" type="submit">Save</button>
        <button class="btn" type="button" data-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}

function staticRow(label: string, value: string, badge: string): string {
  return `<div class="setting setting-static">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">${esc(label)}</span>
        <span class="setting-value${value ? "" : " unset"}">${esc(value || "not set")}</span>
      </div>
      <span class="pill">${esc(badge)}</span>
    </div>
  </div>`;
}

export async function configForm(note = ""): Promise<string> {
  const s = await allSettings();
  const sel = (v: string, o: string) => (v === o ? " selected" : "");
  const backend = store.backend();
  const enc = encryptionEnabled();
  const appPassword = await getSetting("password", "");
  const pwWorks = appPassword ? "set" : APP_PASSWORD ? "from env" : "not set";

  const storedConf = s.rclone_conf ?? "";
  const effectiveConf = storedConf || RCLONE_CONF;
  const confLabel = !effectiveConf
    ? "not set"
    : storedConf
      ? `set (${storedConf.length} base64 chars)`
      : `from RCLONE_CONF env (${RCLONE_CONF.length} base64 chars)`;
  const passwordLabel = appPassword
    ? "set"
    : APP_PASSWORD
      ? "from APP_PASSWORD env"
      : "not set";

  return `<form class="card" hx-post="/config" hx-target="#config-form" hx-swap="outerHTML" id="config-form">
  ${note}
  <p class="muted">
    Backend: <strong>${esc(backend)}</strong>
    &middot; Encryption: <strong>${enc ? "on" : "off"}</strong>
    <span class="pill ${pwWorks === "not set" ? "err" : "ok"}">password ${esc(pwWorks)}</span>
  </p>
  ${settingRow(
    "scan_root",
    s.scan_root || "not set",
    `<label class="field"><span>scan_root</span>
      <input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path"></label>`,
    { unset: !s.scan_root },
  )}
  <label class="field"><span>remote_flags</span>
    <input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--config /data/rclone.conf"></label>
  ${settingRow(
    "rclone_conf",
    confLabel,
    `<label class="field"><span>rclone_conf (base64)</span>
      <textarea name="rclone_conf" rows="5" spellcheck="false" placeholder="base64-encoded rclone.conf">${esc(storedConf)}</textarea></label>
    <p class="muted">Paste a base64-encoded rclone.conf, or a plain INI config. Generate it with <code>base64 -w0 rclone.conf</code>.</p>`,
    { unset: !effectiveConf },
  )}
  ${settingRow(
    "queue_max",
    s.queue_max ?? "500",
    `<label class="field"><span>queue_max</span>
      <input type="number" name="queue_max" value="${esc(s.queue_max ?? "500")}"></label>`,
  )}
  ${settingRow(
    "trash_subdir",
    s.trash_subdir ?? "trash",
    `<label class="field"><span>trash_subdir</span>
      <input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}"></label>`,
  )}
  ${settingRow(
    "sort_by",
    s.sort_by ?? "path",
    `<label class="field"><span>sort_by</span>
      <select name="sort_by">
        <option value="path"${sel(s.sort_by ?? "path", "path")}>path</option>
        <option value="size"${sel(s.sort_by ?? "path", "size")}>size</option>
      </select></label>`,
  )}
  ${settingRow(
    "sort_dir",
    s.sort_dir ?? "asc",
    `<label class="field"><span>sort_dir</span>
      <select name="sort_dir">
        <option value="asc"${sel(s.sort_dir ?? "asc", "asc")}>asc</option>
        <option value="desc"${sel(s.sort_dir ?? "asc", "desc")}>desc</option>
      </select></label>`,
  )}
  ${settingRow(
    "password",
    passwordLabel,
    `<label class="field"><span>password</span>
      <input type="password" name="password" value="${esc(s.password ?? "")}" autocomplete="new-password"></label>`,
    { unset: !appPassword },
  )}
  ${staticRow(
    "database_url",
    s.database_url ?? "",
    "read-only",
  )}
  <p class="muted">database_url is set through the DATABASE_URL environment variable; restart to switch backends.</p>
  <label class="check"><input type="checkbox" name="dry_run"${s.dry_run === "1" ? " checked" : ""}> dry_run</label>
  <label class="check"><input type="checkbox" name="resume"${s.resume === "1" ? " checked" : ""}> Continue previous task (resume after crash/failure)</label>
  <div class="btn-row">
    <button class="btn primary" type="submit">Save</button>
  </div>
</form>`;
}
