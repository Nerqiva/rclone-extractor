import { Hono } from "hono";
import { store, setSetting, allSettings, getSetting } from "../db";
import { engineState, runEngine, stopEngine, forceStopEngine } from "../engine";
import { esc, toastTriggerHeaders } from "../ui";
import { encryptionEnabled } from "../crypto";
import { APP_PASSWORD, RCLONE_CONF } from "../config";
import { normalizeRcloneConf } from "../rcloneconf";
import { Rclone, pendingRcloneConfNotice } from "../rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR_DEFAULT } from "../tmpdir";
import { loadTmpDirSettings } from "../tmpsweep";
import { parseTrashSubdir } from "../archive";

const MAX_CONF_BYTES = 5 * 1024 * 1024;

/** HX-Trigger response header: ask the client to show a toast. */
function toastHeaders(message: string, kind: "ok" | "err" = "ok"): HeadersInit {
  return toastTriggerHeaders(message, kind);
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
  // The Stop button opens the shared stop modal (Soft stop / Hard stop).
  const note = engineState.stopRequested
    ? `<span class="note warn-line stop-note">Stop requested — finishing the current archive…</span>`
    : `<span class="muted">run in progress…</span>`;
  return `<div id="controls" class="btn-row">
    <button class="btn danger" data-modal-open="stop-modal">Stop</button>
    ${note}
  </div>`;
}

actions.post("/run/start", async (c) => {
  if (!engineState.running) {
    await store.run(
      "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE status='failed'",
      [new Date().toISOString()],
    );
    await setSetting("cancel", "0");
    // Settle the rclone.conf working copy up front so a read-only DATA_DIR
    // surfaces as a toast on this response (not just in the server log).
    try {
      await Rclone.fromSettings();
    } catch (e) {
      console.warn("rclone conf pre-sync failed:", String(e));
    }
    const confNotice = pendingRcloneConfNotice();
    // runEngine never rejects (it handles errors internally); log defensively.
    void runEngine().catch((e) => console.error("engine crashed:", String(e)));
    if (confNotice) return c.html(controlsFragment(), 200, toastHeaders(confNotice, "err"));
    return c.html(controlsFragment(), 200, toastHeaders("Task started."));
  }
  return c.html(controlsFragment(), 200, toastHeaders("A task is already running.", "err"));
});

actions.post("/run/stop", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const mode = form ? String(form.get("mode") ?? "soft") : "soft";
  if (!engineState.running) {
    return c.html(controlsFragment());
  }
  if (mode === "hard") {
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
  if (engineState.running) {
    return c.html(
      await configForm(`<p class="note err">Task is running — stop it first.</p>`),
      200,
      RUNNING_GUARD_HEADERS,
    );
  }
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
  if (normalizedConf !== null) {
    await setSetting("rclone_conf", normalizedConf);
    // Keep the working copy in sync right away so a read-only DATA_DIR is
    // reported (and toasted) on this response, not on the next run.
    try {
      await Rclone.fromSettings();
    } catch (e) {
      console.warn("rclone conf sync failed:", String(e));
    }
  }
  await setSetting("dry_run", form.get("dry_run") !== null ? "1" : "0");
  await setSetting("resume", form.get("resume") !== null ? "1" : "0");
  const confNotice = pendingRcloneConfNotice();
  if (confNotice) {
    return c.html(
      await configForm(`<p class="note warn-line">${esc(confNotice)}</p>`),
      200,
      toastHeaders(confNotice, "err"),
    );
  }
  return c.html(
    await configForm(`<p class="note">Saved.</p>`),
    200,
    toastHeaders("Settings saved."),
  );
});

actions.post("/config/rclone-clear", async (c) => {
  if (engineState.running) {
    return c.html(
      await configForm(`<p class="note err">Task is running — stop it first.</p>`),
      200,
      RUNNING_GUARD_HEADERS,
    );
  }
  await setSetting("rclone_conf", "");
  // Never delete the file at RCLONE_CONF_PATH (or its /tmp fallback): it may
  // be the user's mounted rclone.conf. A stored conf is overwritten on the
  // next save.
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
  const tmp = await loadTmpDirSettings();
  if (!tmp.spec) return { ok: false };
  const rc = await Rclone.fromSettings();
  const res = await rc.purgeStaleTemp(
    tmpRootPath(tmp.scanRoot, tmp.spec),
    tmp.dryRun,
  );
  return { ok: true, dryRun: tmp.dryRun, purged: res.purged.length, failed: res.failed.length };
}

function tempPurgeNote(p: Awaited<ReturnType<typeof purgeAppTempDirs>>): string {
  if (!p.ok) return " Temp purge skipped (tmp_dir invalid).";
  if (p.dryRun) return ` Dry run: would purge ${p.purged} temp dir(s).`;
  return ` Purged ${p.purged} temp dir(s)${p.failed ? ` (${p.failed} failed)` : ""}.`;
}

const RUNNING_GUARD = `<p class="note err">Task is running — stop it first.</p>`;
const RUNNING_GUARD_HEADERS = toastHeaders("Stop the task first.", "err");

// Clear queues: allowed even while a task is running. Deletes queued
// archives (and their log rows); a running engine skips rows that are no
// longer queued. Run count, history and caches are untouched.
actions.post("/maintenance/queues", async (c) => {
  const ids = (
    await store.query<{ id: number }>("SELECT id FROM archives WHERE status='queued'")
  ).map((row) => Number(row.id));
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    await store.run(
      `DELETE FROM log_lines WHERE scope='archive' AND ref_id IN (${placeholders})`,
      ids,
    );
    await store.run("DELETE FROM archives WHERE status='queued'");
  }
  const msg = ids.length > 0 ? `Cleared queue (${ids.length} archive(s)).` : "Queue is already empty.";
  return c.html(`<p class="note">${esc(msg)}</p>`, 200, toastHeaders(msg));
});

// Shared wipe behind /maintenance/runs and /maintenance/all: clears the
// queue, run count and the archive cache, along with run/archive logs and
// the run counter (dry-run aware temp purge kept). Returns the purge note.
async function wipeEverything(): Promise<string> {
  await store.run("DELETE FROM log_lines");
  await store.run("DELETE FROM runs");
  await store.run("DELETE FROM archives");
  await resetSequences(["archives", "runs", "log_lines"]);
  await setSetting("last_run_id", "0");
  try {
    return tempPurgeNote(await purgeAppTempDirs());
  } catch (e) {
    return ` Temp purge failed: ${String(e)}`;
  }
}

// Clear History: wipes the queue, run count and the archive cache, along
// with run/archive logs and the run counter (dry-run aware temp purge
// kept). Blocked while a task is running.
actions.post("/maintenance/runs", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  const purgeNote = await wipeEverything();
  return c.html(
    `<p class="note">Cleared history, queue and caches.${esc(purgeNote)} Next run starts from #1.</p>`,
    200,
    toastHeaders("Cleared history; next run starts from #1."),
  );
});

// Clear logs: wipes logs and errors only. Runs and archives are kept.
actions.post("/maintenance/logs", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  await store.run("DELETE FROM log_lines");
  await store.run("UPDATE archives SET error_kind=NULL");
  return c.html(
    `<p class="note">Cleared logs and errors.</p>`,
    200,
    toastHeaders("Cleared logs and errors."),
  );
});

/** Manual purge of stale temp dirs (boot/sweep parity). */
actions.post("/maintenance/tmp-purge", async (c) => {
  if (engineState.running) {
    return c.html(RUNNING_GUARD, 200, RUNNING_GUARD_HEADERS);
  }
  try {
    const p = await purgeAppTempDirs();
    const confNotice = pendingRcloneConfNotice();
    if (!p.ok) {
      return c.html(
        `<p class="note err">tmp_dir is invalid; nothing purged.</p>`,
        200,
        toastHeaders(confNotice ?? "tmp_dir is invalid", "err"),
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
      `<p class="note${p.failed ? " err" : ""}">${esc(msg)}.${esc(detail)}${confNotice ? ` ${esc(confNotice)}` : ""}</p>`,
      200,
      toastHeaders(confNotice ?? msg + detail, confNotice || p.failed ? "err" : "ok"),
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
  const purgeNote = await wipeEverything();
  return c.html(
    `<p class="note">Cleared everything — queue, history, logs, errors and temp dir.${esc(purgeNote)} Next run starts from #1.</p>`,
    200,
    toastHeaders("Cleared everything."),
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
  // While a task is running every setting on this page is out of reach;
  // Clear queues (Maintenance) stays usable. The fieldset disables all
  // nested controls; server-side guards remain as the real enforcement.
  const running = engineState.running;
  const dis = running ? " disabled" : "";
  return `<form class="card${running ? " is-disabled" : ""}" hx-post="/config" hx-encoding="multipart/form-data" hx-target="#config-form" hx-swap="outerHTML" id="config-form">
  ${note}
  ${running ? `<p class="muted">Task running — options are disabled.</p>` : ""}
  <p class="muted">
    Backend: <strong>${esc(backend)}</strong>
    &middot; Encryption: <strong>${enc ? "on" : "off"}</strong>
    <span class="pill ${pwWorks === "not set" ? "err" : "ok"}">APP_PASSWORD ${esc(pwWorks)}</span>
  </p>
  <fieldset class="bare-fieldset"${dis}>
  ${settingRow(
    "scan_root",
    s.scan_root || "not set",
    `<label class="field"><span>scan_root</span>
      <input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path"></label>`,
    { unset: !s.scan_root },
  )}
  <label class="field"><span>remote_flags</span>
    <input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--fast-list"></label>
  ${settingRow(
    "rclone_conf",
    confLabel,
    `<label class="field"><span>rclone.conf</span>
      <input type="file" name="rclone_conf_file" accept=".conf,text/plain"></label>
    <button type="button" class="btn small" hx-post="/config/rclone-clear" hx-target="#config-form" hx-swap="outerHTML" data-confirm="Clear stored rclone.conf?|Clear"><span class="spinner" aria-hidden="true"></span>Clear stored config</button>`,
    { unset: !effectiveConf },
  )}
  ${settingRow(
    "queue_max",
    s.queue_max ?? "500",
    `<label class="field"><span>queue_max</span>
      <input type="number" name="queue_max" min="1" value="${esc(s.queue_max ?? "500")}"></label>`,
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
    { unset: maxSizeBytes <= 0 },
  )}
  ${settingRow(
    "trash_subdir",
    s.trash_subdir ?? "trash",
    `<label class="field"><span>trash_subdir</span>
      <input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}"></label>`,
  )}
  ${settingRow(
    "tmp_dir",
    s.tmp_dir || TMP_DIR_DEFAULT,
    `<label class="field"><span>tmp_dir</span>
      <input type="text" name="tmp_dir" value="${esc(s.tmp_dir ?? "")}" placeholder="${TMP_DIR_DEFAULT}"></label>`,
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
  <label class="check"><input type="checkbox" name="dry_run"${s.dry_run === "1" ? " checked" : ""}> dry_run</label>
  <label class="check"><input type="checkbox" name="resume"${s.resume === "1" ? " checked" : ""}> resume</label>
  <div class="btn-row">
    <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
  </div>
  </fieldset>
</form>`;
}
