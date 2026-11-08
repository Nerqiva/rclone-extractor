import { Hono } from "hono";
import { rmSync } from "node:fs";
import { store, setSetting, allSettings, getSetting } from "../db";
import { engineState, runEngine, stopEngine, forceStopEngine } from "../engine";
import { esc } from "../ui";
import { encryptionEnabled } from "../crypto";
import { APP_PASSWORD, RCLONE_CONF, RCLONE_CONF_PATH } from "../config";
import { normalizeRcloneConf } from "../rcloneconf";
import { Rclone } from "../rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR_DEFAULT } from "../tmpdir";
import { parseTrashSubdir } from "../archive";

const MAX_CONF_BYTES = 5 * 1024 * 1024;

/** HX-Trigger response header: ask the client to show a toast. */
function toastHeaders(message: string, kind: "ok" | "err" = "ok"): HeadersInit {
  // Header values must be ISO-8859-1; strip anything else (e.g. em-dashes).
  const safe = message
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
    .trim();
  return { "HX-Trigger": JSON.stringify({ appToast: { message: safe, kind } }) };
}

export const actions = new Hono();

export function controlsFragment(): string {
  const running = engineState.running;
  if (!running) {
    return `<div id="controls" class="btn-row">
    <button class="btn primary" hx-post="/run/start" hx-target="#controls" hx-swap="outerHTML"><span class="spinner" aria-hidden="true"></span>Start</button>
  </div>`;
  }
  if (engineState.forceStop) {
    return `<div id="controls" class="btn-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    <button class="btn danger solid is-loading" disabled><span class="spinner" aria-hidden="true"></span>Stopping…</button>
    <span class="note warn-line stop-note">Stopping immediately — the current archive was aborted…</span>
  </div>`;
  }
  if (engineState.stopRequested) {
    return `<div id="controls" class="btn-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    <button class="btn danger solid" hx-post="/run/stop" hx-target="#controls" hx-swap="outerHTML"><span class="spinner" aria-hidden="true"></span>Force stop</button>
    <span class="note warn-line stop-note">Stop requested — finishing the current archive. Click Force stop to stop immediately.</span>
  </div>`;
  }
  return `<div id="controls" class="btn-row">
    <button class="btn danger" hx-post="/run/stop" hx-target="#controls" hx-swap="outerHTML"><span class="spinner" aria-hidden="true"></span>Stop</button>
    <span class="muted">run in progress…</span>
  </div>`;
}

actions.post("/run/start", async (c) => {
  if (!engineState.running) {
    await store.run(
      "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE status='failed'",
      [new Date().toISOString()],
    );
    await setSetting("cancel", "0");
    // runEngine never rejects (it handles errors internally); log defensively.
    void runEngine().catch((e) => console.error("engine crashed:", String(e)));
    return c.html(controlsFragment(), 200, toastHeaders("Task started."));
  }
  return c.html(controlsFragment(), 200, toastHeaders("A task is already running.", "err"));
});

actions.post("/run/stop", async (c) => {
  if (!engineState.running) {
    return c.html(controlsFragment());
  }
  if (engineState.stopRequested) {
    forceStopEngine();
    return c.html(
      controlsFragment(),
      200,
      toastHeaders("Stopping immediately — current archive aborted."),
    );
  }
  stopEngine();
  return c.html(
    controlsFragment(),
    200,
    toastHeaders("Stop requested — the current archive will finish first."),
  );
});

const SETTING_KEYS = [
  "scan_root",
  "remote_flags",
  "rclone_conf",
  "queue_max",
  "max_archive_size",
  "sort_by",
  "sort_dir",
  "trash_subdir",
  "tmp_dir",
];

actions.post("/config", async (c) => {
  const form = await c.req.formData();

  const confFile = form.get("rclone_conf_file");
  const confField = form.get("rclone_conf");
  let normalizedConf: string | null = null;
  if (confFile instanceof File && confFile.size > MAX_CONF_BYTES) {
    return c.html(
      await configForm(`<p class="note err">rclone.conf is too large</p>`),
      200,
      toastHeaders("rclone.conf is too large", "err"),
    );
  }
  const source =
    confFile instanceof File && confFile.size > 0
      ? await confFile.text()
      : confField === null
        ? ""
        : String(confField);
  const scanRootNew = form.get("scan_root") !== null
    ? String(form.get("scan_root"))
    : ((await getSetting("scan_root", "")) ?? "");
  const trashRawValue = form.get("trash_subdir") !== null
    ? String(form.get("trash_subdir"))
    : ((await getSetting("trash_subdir", "trash")) ?? "trash");
  let trashStored: string | undefined;
  if (form.get("trash_subdir") !== null) {
    const parsedTrash = parseTrashSubdir(trashRawValue);
    if (!parsedTrash) {
      return c.html(
        await configForm(
          `<p class="note err">trash_subdir is not a usable relative path (no absolute paths, &quot;..&quot; or empty/special segments).</p>`,
        ),
        200,
        toastHeaders("trash_subdir is not usable", "err"),
      );
    }
    trashStored = parsedTrash;
  }
  const trashNew = trashStored ?? trashRawValue;
  let storedTmpDir: string | undefined;
  const tmpRaw = form.get("tmp_dir") === null ? undefined : String(form.get("tmp_dir") ?? "").trim();
  if (tmpRaw !== undefined) {
    const spec = tmpRaw
      ? parseTmpDir(tmpRaw, scanRootNew, trashNew)
      : { kind: "relative" as const, value: TMP_DIR_DEFAULT };
    if (!spec) {
      return c.html(
        await configForm(
          `<p class="note err">tmp_dir is not a usable location (check for &quot;..&quot;, empty segments, or that it does not overlap the trash dir).</p>`,
        ),
        200,
        toastHeaders("tmp_dir is not usable", "err"),
      );
    }
    storedTmpDir = spec.value;
  }
  let maxArchiveSizeStored: string | undefined;
  const maxSizeRaw =
    form.get("max_archive_size") === null
      ? undefined
      : String(form.get("max_archive_size") ?? "").trim();
  if (maxSizeRaw !== undefined) {
    if (maxSizeRaw === "") {
      maxArchiveSizeStored = "0";
    } else {
      const n = Number(maxSizeRaw);
      const multiplier = String(form.get("max_archive_size_unit") ?? "MB") === "GB"
        ? 1024 ** 3
        : 1024 ** 2;
      const bytes = Math.round(n * multiplier);
      if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(bytes)) {
        return c.html(
          await configForm(
            `<p class="note err">max_archive_size must be a non-negative number (0 disables the limit).</p>`,
          ),
          200,
          toastHeaders("max_archive_size is invalid", "err"),
        );
      }
      maxArchiveSizeStored = String(bytes);
    }
  }
  if (source.trim()) {
    const parsed = normalizeRcloneConf(source);
    if (!parsed.ok) {
      return c.html(
        await configForm(`<p class="note err">rclone_conf: ${esc(parsed.error)}</p>`),
        200,
        toastHeaders(`rclone_conf: ${parsed.error}`, "err"),
      );
    }
    normalizedConf = parsed.base64;
  }

  for (const key of SETTING_KEYS) {
    if (key === "rclone_conf") continue;
    if (key === "tmp_dir") continue; // stored normalized below
    if (key === "trash_subdir") continue; // stored normalized below
    if (key === "max_archive_size") continue; // stored normalized below (bytes)
    const value = form.get(key);
    if (value !== null) await setSetting(key, String(value));
  }
  if (trashStored !== undefined) await setSetting("trash_subdir", trashStored);
  if (storedTmpDir !== undefined) await setSetting("tmp_dir", storedTmpDir);
  if (maxArchiveSizeStored !== undefined) {
    await setSetting("max_archive_size", maxArchiveSizeStored);
  }
  if (normalizedConf !== null) await setSetting("rclone_conf", normalizedConf);
  await setSetting("dry_run", form.get("dry_run") !== null ? "1" : "0");
  await setSetting("resume", form.get("resume") !== null ? "1" : "0");
  return c.html(
    await configForm(`<p class="note">Saved.</p>`),
    200,
    toastHeaders("Settings saved."),
  );
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

actions.post("/config/rclone-clear", async (c) => {
  await setSetting("rclone_conf", "");
  try {
    rmSync(RCLONE_CONF_PATH, { force: true });
  } catch {}
  return c.html(
    await configForm(`<p class="note">rclone.conf cleared.</p>`),
    200,
    toastHeaders("Stored rclone.conf cleared."),
  );
});

/** Reset AUTOINCREMENT/serial sequences so ids restart at 1. */
async function resetSequences(tables: string[]): Promise<void> {
  for (const table of tables) {
    try {
      if (store.backend() === "postgres") {
        await store.run(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), 1, false)`,
        );
      } else {
        await store.run("DELETE FROM sqlite_sequence WHERE name = ?", [table]);
      }
    } catch (e) {
      console.warn(`could not reset ${table} sequence:`, String(e));
    }
  }
}

/** Purge app-owned numeric temp run dirs (same rules as the manual purge). */
async function purgeAppTempDirs(): Promise<
  | { ok: true; dryRun: boolean; purged: number; failed: number }
  | { ok: false }
> {
  const dryRun = (await getSetting("dry_run", "0")) === "1";
  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  const trash = (await getSetting("trash_subdir", "trash")) ?? "trash";
  const raw = ((await getSetting("tmp_dir", TMP_DIR_DEFAULT)) ?? TMP_DIR_DEFAULT).trim();
  const spec = raw
    ? parseTmpDir(raw, scanRoot, trash)
    : { kind: "relative" as const, value: TMP_DIR_DEFAULT };
  if (!spec) return { ok: false };
  const rc = await Rclone.fromSettings();
  const res = await rc.purgeStaleTemp(tmpRootPath(scanRoot, spec), dryRun);
  return { ok: true, dryRun, purged: res.purged.length, failed: res.failed.length };
}

function tempPurgeNote(p: Awaited<ReturnType<typeof purgeAppTempDirs>>): string {
  if (!p.ok) return " Temp purge skipped (tmp_dir invalid).";
  if (p.dryRun) return ` Dry run: would purge ${p.purged} temp dir(s).`;
  return ` Purged ${p.purged} temp dir(s)${p.failed ? ` (${p.failed} failed)` : ""}.`;
}

const RUNNING_GUARD = `<p class="note err">Task is running — stop it first.</p>`;
const RUNNING_GUARD_HEADERS = toastHeaders("Stop the task first.", "err");

actions.post("/maintenance/archives", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  await store.run("DELETE FROM log_lines WHERE scope='archive'");
  await store.run("DELETE FROM logs");
  await store.run("DELETE FROM archives");
  return c.html(
    `<p class="note">Cleared archive queue.</p>`,
    200,
    toastHeaders("Cleared archive queue."),
  );
});

actions.post("/maintenance/runs", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  await store.run("DELETE FROM log_lines WHERE scope='run'");
  await store.run("DELETE FROM runs");
  await resetSequences(["runs"]);
  await setSetting("last_run_id", "0");
  let purgeNote = "";
  try {
    purgeNote = tempPurgeNote(await purgeAppTempDirs());
  } catch (e) {
    purgeNote = ` Temp purge failed: ${String(e)}`;
  }
  return c.html(
    `<p class="note">Cleared run history and logs.${esc(purgeNote)} Next run starts from #1.</p>`,
    200,
    toastHeaders(`Cleared run history; next run starts from #1.`),
  );
});

/** Manual purge of stale temp dirs (boot/sweep parity). */
actions.post("/maintenance/tmp-purge", async (c) => {
  try {
    const p = await purgeAppTempDirs();
    if (!p.ok) {
      return c.html(
        `<p class="note err">tmp_dir is invalid; nothing purged.</p>`,
        200,
        toastHeaders("tmp_dir is invalid", "err"),
      );
    }
    const none = p.purged === 0 && p.failed === 0;
    const msg = p.dryRun
      ? none
        ? "Dry run: temp directory is tidy"
        : `Dry run: would purge ${p.purged} stale item(s)`
      : none
        ? "Temp directory is tidy"
        : `Purged ${p.purged} stale item(s)`;
    const detail = p.failed ? ` ${p.failed} could not be purged.` : "";
    return c.html(
      `<p class="note${p.failed ? " err" : ""}">${esc(msg)}.${esc(detail)}</p>`,
      200,
      toastHeaders(msg + detail, p.failed ? "err" : "ok"),
    );
  } catch (e) {
    return c.html(
      `<p class="note err">Purge failed: ${esc(String(e))}</p>`,
      200,
      toastHeaders("Purge failed", "err"),
    );
  }
});

actions.post("/maintenance/all", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  await store.run("DELETE FROM log_lines");
  await store.run("DELETE FROM logs");
  await store.run("DELETE FROM runs");
  await store.run("DELETE FROM archives");
  await resetSequences(["archives", "runs", "log_lines"]);
  await setSetting("last_run_id", "0");
  let purgeNote = "";
  try {
    purgeNote = tempPurgeNote(await purgeAppTempDirs());
  } catch (e) {
    purgeNote = ` Temp purge failed: ${String(e)}`;
  }
  return c.html(
    `<p class="note">Cleared all task data and logs.${esc(purgeNote)} Next run starts from #1.</p>`,
    200,
    toastHeaders("Cleared all task data and logs."),
  );
});

function settingRow(
  label: string,
  value: string,
  editor: string,
  opts: { unset?: boolean; hint?: string } = {},
): string {
  return `<div class="setting">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">${esc(label)}</span>
        <span class="setting-value${opts.unset ? " unset" : ""}">${esc(value)}</span>
        ${opts.hint ? `<span class="field-hint">${opts.hint}</span>` : ""}
      </div>
      <button type="button" class="btn small" data-edit>Edit</button>
    </div>
    <div class="setting-editor">
      ${editor}
      <div class="btn-row">
        <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
        <button class="btn" type="button" data-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}

/** Format stored max_archive_size bytes for the collapsed row label. */
function formatMaxArchiveSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "no limit";
  const gb = bytes / 1024 ** 3;
  if (Number.isInteger(gb)) return `${gb} GB`;
  return `${Number((bytes / 1024 ** 2).toFixed(2))} MB`;
}

/** Split stored max_archive_size bytes into an editable value + unit. */
function splitMaxArchiveSize(bytes: number): { value: string; unit: "MB" | "GB" } {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) {
    return { value: String(bytes / 1024 ** 3), unit: "GB" };
  }
  return { value: String(Number((bytes / 1024 ** 2).toFixed(2))), unit: "MB" };
}

export async function configForm(note = ""): Promise<string> {
  const s = await allSettings();
  const sel = (v: string, o: string) => (v === o ? " selected" : "");
  const backend = store.backend();
  const enc = encryptionEnabled();
  const pwWorks = APP_PASSWORD ? "set" : "not set";

  const storedConf = s.rclone_conf ?? "";
  const effectiveConf = storedConf || RCLONE_CONF;
  const confLabel = !effectiveConf
    ? "not set"
    : storedConf
      ? "set"
      : "from RCLONE_CONF env";
  const maxSizeRaw = Number(s.max_archive_size ?? "0");
  const maxSizeBytes =
    Number.isFinite(maxSizeRaw) && maxSizeRaw > 0 ? Math.floor(maxSizeRaw) : 0;
  const maxSizeSplit = splitMaxArchiveSize(maxSizeBytes);
  return `<form class="card" hx-post="/config" hx-encoding="multipart/form-data" hx-target="#config-form" hx-swap="outerHTML" id="config-form">
  ${note}
  <p class="muted">
    Backend: <strong>${esc(backend)}</strong>
    &middot; Encryption: <strong>${enc ? "on" : "off"}</strong>
    <span class="pill ${pwWorks === "not set" ? "err" : "ok"}">APP_PASSWORD ${esc(pwWorks)}</span>
  </p>
  ${settingRow(
    "scan_root",
    s.scan_root || "not set",
    `<label class="field"><span>scan_root</span>
      <input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path"></label>`,
    { unset: !s.scan_root, hint: `Root to scan. Example: <code>remote:path</code> or <code>/local/path</code>.` },
  )}
  <label class="field"><span>remote_flags</span>
    <input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--fast-list"></label>
  <p class="field-hint">Extra flags for remote commands. Example: <code>--fast-list</code>.</p>
  ${settingRow(
    "rclone_conf",
    confLabel,
    `<label class="field"><span>rclone.conf</span>
      <input type="file" name="rclone_conf_file" accept=".conf,text/plain"></label>
    <button type="button" class="btn small" hx-post="/config/rclone-clear" hx-target="#config-form" hx-swap="outerHTML"><span class="spinner" aria-hidden="true"></span>Clear stored config</button>`,
    {
      unset: !effectiveConf,
      hint: `Falls back to <code>RCLONE_CONF</code> env when unset.`,
    },
  )}
  ${settingRow(
    "queue_max",
    s.queue_max ?? "500",
    `<label class="field"><span>queue_max</span>
      <input type="number" name="queue_max" min="1" value="${esc(s.queue_max ?? "500")}"></label>`,
    { hint: `Max archives queued per run. Default <code>500</code>.` },
  )}
  ${settingRow(
    "max_archive_size",
    formatMaxArchiveSize(maxSizeBytes),
    `<label class="field"><span>max_archive_size</span>
      <div class="field-inline">
        <input type="number" name="max_archive_size" min="0" step="any" value="${esc(maxSizeSplit.value)}" placeholder="0">
        <select name="max_archive_size_unit">
          <option value="MB"${maxSizeSplit.unit === "MB" ? " selected" : ""}>MB</option>
          <option value="GB"${maxSizeSplit.unit === "GB" ? " selected" : ""}>GB</option>
        </select>
      </div></label>`,
    { unset: maxSizeBytes <= 0, hint: `Skips archives larger than this. <code>0</code> = no limit.` },
  )}
  ${settingRow(
    "trash_subdir",
    s.trash_subdir ?? "trash",
    `<label class="field"><span>trash_subdir</span>
      <input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}"></label>`,
    { hint: `Where processed archives are moved. Relative to <code>scan_root</code>.` },
  )}
  ${settingRow(
    "tmp_dir",
    s.tmp_dir || TMP_DIR_DEFAULT,
    `<label class="field"><span>tmp_dir</span>
      <input type="text" name="tmp_dir" value="${esc(s.tmp_dir ?? "")}" placeholder="${TMP_DIR_DEFAULT}"></label>`,
    { hint: `Where archives are extracted. Relative = inside <code>scan_root</code>; absolute path or <code>remote:path</code> elsewhere. <strong class="warn">Must not overlap <code>trash_subdir</code>.</strong>` },
  )}
  ${settingRow(
    "sort_by",
    s.sort_by ?? "path",
    `<label class="field"><span>sort_by</span>
      <select name="sort_by">
        <option value="path"${sel(s.sort_by ?? "path", "path")}>path</option>
        <option value="size"${sel(s.sort_by ?? "path", "size")}>size</option>
      </select></label>`,
    { hint: `Queue sort field.` },
  )}
  ${settingRow(
    "sort_dir",
    s.sort_dir ?? "asc",
    `<label class="field"><span>sort_dir</span>
      <select name="sort_dir">
        <option value="asc"${sel(s.sort_dir ?? "asc", "asc")}>asc</option>
        <option value="desc"${sel(s.sort_dir ?? "asc", "desc")}>desc</option>
      </select></label>`,
    { hint: `Queue sort direction.` },
  )}
  <label class="check"><input type="checkbox" name="dry_run"${s.dry_run === "1" ? " checked" : ""}> dry_run — simulate only; nothing is moved or deleted</label>
  <label class="check"><input type="checkbox" name="resume"${s.resume === "1" ? " checked" : ""}> resume — re-queue archives interrupted mid-extraction on next start</label>
  <div class="btn-row">
    <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
  </div>
</form>`;
}
