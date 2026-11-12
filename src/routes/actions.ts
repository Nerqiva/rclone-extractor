import { Hono } from "hono";
import { store, setSetting, allSettings, getSetting } from "../db";
import {
  engineState,
  runEngine,
  stopEngine,
  forceStopEngine,
  requestSkipListing,
  requestSkipInspection,
  requestSkipArchive,
} from "../engine";
import { esc, toastTriggerHeaders, info } from "../ui";
import { encryptionEnabled } from "../crypto";
import { APP_PASSWORD, RCLONE_CONF } from "../config";
import { normalizeRcloneConf } from "../rcloneconf";
import { Rclone, pendingRcloneConfNotice } from "../rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR_DEFAULT } from "../tmpdir";
import { loadTmpDirSettings } from "../tmpsweep";
import { parseTrashSubdir } from "../archive";

const MAX_CONF_BYTES = 5 * 1024 * 1024;

/**
 * Parse an MB/GB size field into bytes. "0" (or an empty field, stored by the
 * caller) means "no limit". Returns null when the value is unusable.
 */
function parseSizeInput(raw: string, unit: string): number | null {
  const n = Number(raw);
  const multiplier = unit === "GB" ? 1024 ** 3 : 1024 ** 2;
  const bytes = Math.round(n * multiplier);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(bytes)) {
    return null;
  }
  return bytes;
}

/** HX-Trigger response header: ask the client to show a toast. */
function toastHeaders(message: string, kind: "ok" | "err" = "ok"): HeadersInit {
  return toastTriggerHeaders(message, kind);
}

export const actions = new Hono();

export function controlsFragment(): string {
  const running = engineState.running;
  if (!running) {
    return `<div id="controls" class="controls-idle">
    <form class="controls-start" hx-post="/run/start" hx-target="#controls" hx-swap="outerHTML">
      <label class="check"><input type="checkbox" name="reuse_scan" value="1"> Reuse previous scan results${info(
        "Reuse the cached archive list from the last completed scan of this scan_root instead of rescanning the remote. Falls back to a fresh scan when the cache is missing, stale, or for a different scan_root. This choice is not remembered for future runs.",
      )}</label>
      <div class="btn-row">
        <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Start</button>
      </div>
    </form>
  </div>`;
  }
  if (engineState.forceStop) {
    return `<div id="controls" class="btn-row controls-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    <span class="note warn-line stop-note">Stopping immediately — the current archive was aborted…</span>
    <button class="btn danger solid is-loading btn-stop" disabled><span class="spinner" aria-hidden="true"></span>Stopping…</button>
  </div>`;
  }
  // The Stop button opens the shared stop modal (Soft stop / Hard stop).
  const stage = engineState.stage;
  const activity = engineState.activity;
  const skips: string[] = [];
  if (stage === "listing") {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"listing"}' hx-target="#controls" hx-swap="outerHTML">Skip listing</button>${info(
        "Stop the scan now and continue with the queue built from the archives already stored. Treated as completed, this run only.",
      )}`,
    );
  }
  if (activity === "Inspecting archive") {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"inspection"}' hx-target="#controls" hx-swap="outerHTML">Skip inspection</button>${info(
        "Treat the inspection as passed for the current archive only and extract it. Temporary, this archive only.",
      )}`,
    );
  }
  if (stage === "extracting") {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"archive"}' hx-target="#controls" hx-swap="outerHTML">Skip archive</button>${info(
        "Stop the current archive and leave it queued — it is retried on the next run. Temporary, this run only.",
      )}`,
    );
  }
  const note = engineState.stopRequested
    ? `<span class="note warn-line stop-note">Stop requested — finishing the current archive…</span>`
    : `<span class="muted">run in progress…</span>`;
  return `<div id="controls" class="btn-row controls-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    ${skips.join("\n    ")}
    ${note}
    <button class="btn danger btn-stop" data-modal-open="stop-modal">Stop</button>
  </div>`;
}

actions.post("/run/start", async (c) => {
  if (!engineState.running) {
    const form = await c.req.formData().catch(() => null);
    const reuseScan = form?.get("reuse_scan") === "1";
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
    void runEngine({ reuseScan }).catch((e) => console.error("engine crashed:", String(e)));
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

actions.post("/run/skip", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const target = form ? String(form.get("target") ?? "") : "";
  let ok = false;
  if (target === "listing") ok = requestSkipListing();
  else if (target === "inspection") ok = requestSkipInspection();
  else if (target === "archive") ok = requestSkipArchive();
  if (!ok) {
    return c.html(
      controlsFragment(),
      200,
      toastHeaders("Nothing to skip right now.", "err"),
    );
  }
  const msg =
    target === "listing"
      ? "Listing skipped — building the queue from stored archives."
      : target === "inspection"
        ? "Inspection skipped — extracting this archive."
        : "Archive skipped — it stays queued for the next run.";
  return c.html(controlsFragment(), 200, toastHeaders(msg));
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
  let minArchiveSizeStored: string | undefined;
  const minSizeRaw =
    form.get("min_archive_size") === null
      ? undefined
      : String(form.get("min_archive_size") ?? "").trim();
  if (minSizeRaw !== undefined) {
    if (minSizeRaw === "") {
      minArchiveSizeStored = "0";
    } else {
      const minBytes = parseSizeInput(
        minSizeRaw,
        String(form.get("min_archive_size_unit") ?? "MB"),
      );
      if (minBytes === null) {
        return c.html(
          await configForm(
            `<p class="note err">min_archive_size must be a non-negative number (0 disables the limit).</p>`,
          ),
          200,
          toastHeaders("min_archive_size is invalid", "err"),
        );
      }
      minArchiveSizeStored = String(minBytes);
    }
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
      const maxBytes = parseSizeInput(
        maxSizeRaw,
        String(form.get("max_archive_size_unit") ?? "MB"),
      );
      if (maxBytes === null) {
        return c.html(
          await configForm(
            `<p class="note err">max_archive_size must be a non-negative number (0 disables the limit).</p>`,
          ),
          200,
          toastHeaders("max_archive_size is invalid", "err"),
        );
      }
      maxArchiveSizeStored = String(maxBytes);
    }
  }
  // RcloneX extraction flags. Passwords are write-only here: leaving the
  // field blank keeps the stored one; clearing happens via the Clear button.
  const passwordRaw = form.get("rclonex_archive_password");
  let rclonexPasswordStored: string | undefined;
  if (passwordRaw !== null) {
    const pw = String(passwordRaw);
    if (pw.length > 4096) {
      return c.html(
        await configForm(
          `<p class="note err">rclonex_archive_password is too long (max 4096 characters).</p>`,
        ),
        200,
        toastHeaders("rclonex_archive_password is invalid", "err"),
      );
    }
    if (pw !== "") rclonexPasswordStored = pw; // blank: keep the stored one
  }
  const windowRaw = form.get("rclonex_window_size");
  const windowEnabled = form.get("rclonex_window_size_enabled") !== null;
  let rclonexWindowStored: string | undefined;
  if (windowRaw !== null) {
    const t = String(windowRaw).trim();
    if (t !== "") {
      const n = Number(t);
      if (!Number.isSafeInteger(n) || n < 0) {
        return c.html(
          await configForm(
            `<p class="note err">rclonex_window_size must be a non-negative integer number of bytes (0 disables caching).</p>`,
          ),
          200,
          toastHeaders("rclonex_window_size is invalid", "err"),
        );
      }
      rclonexWindowStored = String(n);
    } else if (windowEnabled) {
      return c.html(
        await configForm(
          `<p class="note err">Enter a window size in bytes (0 disables caching), or uncheck the override.</p>`,
        ),
        200,
        toastHeaders("rclonex_window_size is invalid", "err"),
      );
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
  if (minArchiveSizeStored !== undefined) {
    await setSetting("min_archive_size", minArchiveSizeStored);
  }
  await setSetting("rclonex", form.get("rclonex") !== null ? "1" : "0");
  await setSetting(
    "rclonex_skip_inspection",
    form.get("rclonex_skip_inspection") !== null ? "1" : "0",
  );
  await setSetting(
    "auto_skip_known",
    form.get("auto_skip_known") !== null ? "1" : "0",
  );
  await setSetting(
    "rclonex_continue_on_error",
    form.get("rclonex_continue_on_error") !== null ? "1" : "0",
  );
  await setSetting(
    "rclonex_archive_password_enabled",
    form.get("rclonex_archive_password_enabled") !== null ? "1" : "0",
  );
  await setSetting(
    "rclonex_window_size_enabled",
    form.get("rclonex_window_size_enabled") !== null ? "1" : "0",
  );
  if (rclonexPasswordStored !== undefined) {
    await setSetting("rclonex_archive_password", rclonexPasswordStored);
  }
  if (rclonexWindowStored !== undefined) {
    await setSetting("rclonex_window_size", rclonexWindowStored);
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

actions.post("/config/rclonex-clear", async (c) => {
  if (engineState.running) {
    return c.html(
      await configForm(`<p class="note err">Task is running — stop it first.</p>`),
      200,
      RUNNING_GUARD_HEADERS,
    );
  }
  await setSetting("rclonex_archive_password", "");
  await setSetting("rclonex_archive_password_enabled", "0");
  return c.html(
    await configForm(`<p class="note">Archive password cleared.</p>`),
    200,
    toastHeaders("Archive password cleared."),
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
  await setSetting("scan_cache_state", "incomplete");
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
  opts: { unset?: boolean; info?: string } = {},
): string {
  return `<div class="setting">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">${esc(label)}${opts.info ? ` ${info(opts.info)}` : ""}</span>
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

/** Format a stored size limit in bytes for the collapsed row label. */
function formatSizeLimit(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "no limit";
  const gb = bytes / 1024 ** 3;
  if (Number.isInteger(gb)) return `${gb} GB`;
  return `${Number((bytes / 1024 ** 2).toFixed(2))} MB`;
}

/** Split a stored size limit (bytes) into an editable value + unit. */
function splitSizeLimit(bytes: number): { value: string; unit: "MB" | "GB" } {
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
  const maxSizeSplit = splitSizeLimit(maxSizeBytes);
  const minSizeRaw = Number(s.min_archive_size ?? "0");
  const minSizeBytes =
    Number.isFinite(minSizeRaw) && minSizeRaw > 0 ? Math.floor(minSizeRaw) : 0;
  const minSizeSplit = splitSizeLimit(minSizeBytes);
  const maxSizeTooHigh = maxSizeBytes > 0 && minSizeBytes > 0 && maxSizeBytes < minSizeBytes;
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
  ${maxSizeTooHigh ? `<p class="note warn-line">max_archive_size is below min_archive_size — every archive is excluded.</p>` : ""}
  ${settingRow(
    "scan_root",
    s.scan_root || "not set",
    `<label class="field"><input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path" aria-label="scan_root"></label>`,
    {
      unset: !s.scan_root,
      info: "Remote or path to scan for archives, e.g. s3:bucket/archives or /data/in.",
    },
  )}
  <label class="field"><span>remote_flags ${info("Extra flags appended to every rclone command. --config is passed unconditionally; a --config here is ignored.")}</span>
    <input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--fast-list"></label>
  ${settingRow(
    "rclone_conf",
    confLabel,
    `<label class="field"><input type="file" name="rclone_conf_file" accept=".conf,text/plain" aria-label="rclone.conf"></label>
    <button type="button" class="btn small" hx-post="/config/rclone-clear" hx-target="#config-form" hx-swap="outerHTML" data-confirm="Clear stored rclone.conf?|Clear"><span class="spinner" aria-hidden="true"></span>Clear stored config</button>`,
    {
      unset: !effectiveConf,
      info: "rclone config, stored encrypted and written to /app/data/rclone.conf (or /tmp fallback) before rclone runs. Falls back to the RCLONE_CONF env var when empty.",
    },
  )}
  ${settingRow(
    "queue_max",
    s.queue_max ?? "500",
    `<label class="field"><input type="number" name="queue_max" min="1" value="${esc(s.queue_max ?? "500")}" aria-label="queue_max"></label>`,
    { info: "Maximum archives queued and processed per run." },
  )}
  ${settingRow(
    "min_archive_size",
    formatSizeLimit(minSizeBytes),
    `<label class="field"><div class="field-inline">
        <input type="number" name="min_archive_size" min="0" step="any" value="${esc(minSizeSplit.value)}" placeholder="0" aria-label="min_archive_size">
        <select name="min_archive_size_unit" aria-label="min_archive_size unit">
          <option value="MB"${minSizeSplit.unit === "MB" ? " selected" : ""}>MB</option>
          <option value="GB"${minSizeSplit.unit === "GB" ? " selected" : ""}>GB</option>
        </select>
      </div></label>`,
    {
      unset: minSizeBytes <= 0,
      info: "Ignore archives smaller than this — never queued, and skipped when previously queued. Entered in MB or GB (stored in bytes); 0 = no limit (default).",
    },
  )}
  ${settingRow(
    "max_archive_size",
    formatSizeLimit(maxSizeBytes),
    `<label class="field"><div class="field-inline">
        <input type="number" name="max_archive_size" min="0" step="any" value="${esc(maxSizeSplit.value)}" placeholder="0" aria-label="max_archive_size">
        <select name="max_archive_size_unit" aria-label="max_archive_size unit">
          <option value="MB"${maxSizeSplit.unit === "MB" ? " selected" : ""}>MB</option>
          <option value="GB"${maxSizeSplit.unit === "GB" ? " selected" : ""}>GB</option>
        </select>
      </div></label>`,
    {
      unset: maxSizeBytes <= 0,
      info: "Ignore archives larger than this — never queued, and skipped when previously queued; raising the limit takes effect on the next run. Entered in MB or GB (stored in bytes); 0 = no limit (default).",
    },
  )}
  ${settingRow(
    "trash_subdir",
    s.trash_subdir ?? "trash",
    `<label class="field"><input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}" aria-label="trash_subdir"></label>`,
    { info: "Folder processed archives are moved into." },
  )}
  ${settingRow(
    "tmp_dir",
    s.tmp_dir || TMP_DIR_DEFAULT,
    `<label class="field"><input type="text" name="tmp_dir" value="${esc(s.tmp_dir ?? "")}" placeholder="${TMP_DIR_DEFAULT}" aria-label="tmp_dir"></label>`,
    { info: "Where archives are extracted temporarily (default .rclone-extractor-tmp). A relative path resolves inside scan_root." },
  )}
  ${settingRow(
    "sort_by",
    s.sort_by ?? "path",
    `<label class="field"><select name="sort_by" aria-label="sort_by">
        <option value="path"${sel(s.sort_by ?? "path", "path")}>path</option>
        <option value="size"${sel(s.sort_by ?? "path", "size")}>size</option>
      </select></label>`,
    { info: "Process archives by path or by size." },
  )}
  ${settingRow(
    "sort_dir",
    s.sort_dir ?? "asc",
    `<label class="field"><select name="sort_dir" aria-label="sort_dir">
        <option value="asc"${sel(s.sort_dir ?? "asc", "asc")}>asc</option>
        <option value="desc"${sel(s.sort_dir ?? "asc", "desc")}>desc</option>
      </select></label>`,
    { info: "Queue order direction (asc or desc)." },
  )}
  <label class="check"><input type="checkbox" name="dry_run"${s.dry_run === "1" ? " checked" : ""}> dry_run${info("Run all rclone commands with --dry-run — nothing is moved or deleted.")}</label>
  <label class="check"><input type="checkbox" name="resume"${s.resume === "1" ? " checked" : ""}> resume${info("Re-queue archives interrupted mid-run on the next start; when off they are marked failed/interrupted.")}</label>
  <label class="check"><input type="checkbox" name="auto_skip_known"${(s.auto_skip_known ?? "1") === "1" ? " checked" : ""}> auto_skip_known${info("Archives previously classified as a torrent or website dump that reappear are skipped automatically, without re-inspection. Uncheck to re-inspect them on later runs.")}</label>
  <h2 class="section-title" style="margin:4px 0 12px">RcloneX</h2>
  <label class="check"><input type="checkbox" name="rclonex"${s.rclonex === "1" ? " checked" : ""}> Enable RcloneX${info("Extract RAR/RAR5, multivolume RAR (.partN.rar, .rNN), 7Z and split 7Z (.7z.NNN), and ISO via Nerqiva/rclonex. Everything else stays on rclone; when disabled those formats are not queued.")}</label>
  <label class="check"><input type="checkbox" name="rclonex_skip_inspection"${(s.rclonex_skip_inspection ?? "1") === "1" ? " checked" : ""}> Skip inspection for RcloneX formats${info("Skips the archive content inspection for archives handled by RcloneX (default — rclonex does not list rar/7z/iso). Other formats are always inspected.")}</label>
  <label class="check"><input type="checkbox" name="rclonex_continue_on_error"${s.rclonex_continue_on_error === "1" ? " checked" : ""}> Continue on entry errors${info("--archive-continue-on-error: keep extracting when an archive entry fails instead of aborting the whole archive.")}</label>
  <div class="check"><input type="checkbox" name="rclonex_archive_password_enabled" id="rclonex-pw"${s.rclonex_archive_password_enabled === "1" ? " checked" : ""}> <label for="rclonex-pw">Archive password${info("--archive-password: password for encrypted RAR and 7Z archives (also multivolume sets). Blank keeps the stored password; Clear removes it. Stored encrypted at rest.")}</label><input class="check-input" type="password" name="rclonex_archive_password" placeholder="${s.rclonex_archive_password ? "leave blank to keep stored" : "not set"}" autocomplete="new-password" aria-label="rclonex archive password"><button type="button" class="btn small" hx-post="/config/rclonex-clear" hx-target="#config-form" hx-swap="outerHTML" data-confirm="Clear stored archive password?|Clear password"><span class="spinner" aria-hidden="true"></span>Clear</button></div>
  <div class="check"><input type="checkbox" name="rclonex_window_size_enabled" id="rclonex-win"${s.rclonex_window_size_enabled === "1" ? " checked" : ""}> <label for="rclonex-win">Override window size${info("--archive-window-size: sliding-window cache in bytes for random-access formats read by rclonex (7Z, ISO). 0 disables caching. Unchecked keeps rclonex's 16 MiB default.")}</label><input class="check-input small-num" type="number" min="0" name="rclonex_window_size" value="${esc(s.rclonex_window_size ?? "16777216")}" aria-label="rclonex window size"></div>
  <div class="btn-row">
    <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
  </div>
  </fieldset>
</form>`;
}
