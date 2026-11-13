import { Hono, type Context } from "hono";
import { store, setSetting, getSetting } from "../db";
import {
  engineState,
  runEngine,
  stopEngine,
  forceStopEngine,
  requestSkipListing,
  requestSkipInspection,
  requestSkipArchive,
} from "../engine";
import { esc, toastTriggerHeaders } from "../ui";
import { normalizeRcloneConf } from "../rcloneconf";
import { Rclone, pendingRcloneConfNotice } from "../rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR_DEFAULT } from "../tmpdir";
import { loadTmpDirSettings } from "../tmpsweep";
import { parseTrashSubdir, isSafeRel, normalizeRel } from "../archive";
import { readPasswordRows, renderPasswordList } from "../passwordrows";
import { controlsFragment, configForm } from "../views";

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

export const actions = new Hono();

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
    if (confNotice) return c.html(controlsFragment(), 200, toastTriggerHeaders(confNotice, "err"));
    return c.html(controlsFragment(), 200, toastTriggerHeaders("Task started."));
  }
  return c.html(controlsFragment(), 200, toastTriggerHeaders("A task is already running.", "err"));
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
      toastTriggerHeaders("Stopping immediately — current archive aborted."),
    );
  }
  stopEngine();
  return c.html(
    controlsFragment(),
    200,
    toastTriggerHeaders("Stop requested — the current archive will finish first."),
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
      toastTriggerHeaders("Nothing to skip right now.", "err"),
    );
  }
  const msg =
    target === "listing"
      ? "Listing skipped — building the queue from stored archives."
      : target === "inspection"
        ? "Inspection skipped — extracting this archive."
        : "Archive skipped — it stays queued for the next run.";
  return c.html(controlsFragment(), 200, toastTriggerHeaders(msg));
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
      toastTriggerHeaders("rclone.conf is too large", "err"),
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
        toastTriggerHeaders("trash_subdir is not usable", "err"),
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
        toastTriggerHeaders("tmp_dir is not usable", "err"),
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
          toastTriggerHeaders("min_archive_size is invalid", "err"),
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
          toastTriggerHeaders("max_archive_size is invalid", "err"),
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
        toastTriggerHeaders("rclonex_archive_password is invalid", "err"),
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
          toastTriggerHeaders("rclonex_window_size is invalid", "err"),
        );
      }
      rclonexWindowStored = String(n);
    } else if (windowEnabled) {
      return c.html(
        await configForm(
          `<p class="note err">Enter a window size in bytes (0 disables caching), or uncheck the override.</p>`,
        ),
        200,
        toastTriggerHeaders("rclonex_window_size is invalid", "err"),
      );
    }
  }
  if (source.trim()) {
    const parsed = normalizeRcloneConf(source);
    if (!parsed.ok) {
      return c.html(
        await configForm(`<p class="note err">rclone_conf: ${esc(parsed.error)}</p>`),
        200,
        toastTriggerHeaders(`rclone_conf: ${parsed.error}`, "err"),
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
      toastTriggerHeaders(confNotice, "err"),
    );
  }
  return c.html(
    await configForm(`<p class="note">Saved.</p>`),
    200,
    toastTriggerHeaders("Settings saved."),
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
    toastTriggerHeaders("Stored rclone.conf cleared."),
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
    toastTriggerHeaders("Archive password cleared."),
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
const RUNNING_GUARD_HEADERS = toastTriggerHeaders("Stop the task first.", "err");

async function passwordListResponse(c: Context, toast: string, toastKind: "ok" | "err" = "ok"): Promise<Response> {
  const rows = await readPasswordRows();
  return c.html(renderPasswordList(rows), 200, toastTriggerHeaders(toast, toastKind));
}

// Password-section actions (Errors page). A password-protected archive is
// moved into the trash subdir (never deleted outright), and can be restored
// afterwards: back into the queue, error_kind cleared, so the next run
// retries it. Both moves refuse to overwrite anything already in place.
async function movePasswordArchive(
  c: Context,
  direction: "delete" | "restore",
): Promise<Response> {
  const del = direction === "delete";
  if (engineState.running) {
    return passwordListResponse(c, "Stop the task first.", "err");
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return passwordListResponse(c, "Not found.", "err");
  }
  const row = await store.get1<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives WHERE id = ?",
    [id],
  );
  if (!row || row.error_kind !== "password") {
    return passwordListResponse(c, "Not a password-protected archive.", "err");
  }
  if (del ? row.status === "deleted" : row.status !== "deleted") {
    return passwordListResponse(c, del ? "Already in trash." : "Archive is not in trash.");
  }
  const rel = String(row.path);
  if (!isSafeRel(rel)) {
    return passwordListResponse(c, "Stored path is unsafe; refusing to move it.", "err");
  }
  const trash = parseTrashSubdir((await getSetting("trash_subdir", "trash")) ?? "trash");
  if (!trash) {
    return passwordListResponse(c, "trash_subdir is invalid.", "err");
  }
  const dryRun = (await getSetting("dry_run", "0")) === "1";
  const ref = { scope: "archive" as const, refId: id, kind: "extract" as const };
  const rc = await Rclone.fromSettings();
  const trashRel = normalizeRel(`${trash}/${rel}`);
  const srcRel = del ? rel : trashRel;
  const destRel = del ? trashRel : rel;
  if (await rc.existsPath(destRel)) {
    return passwordListResponse(
      c,
      del
        ? `The trash already contains ${destRel} — remove it before deleting.`
        : `A file now exists at ${destRel} — remove it before restoring.`,
      "err",
    );
  }
  const res = await rc.moveToRel(srcRel, destRel, dryRun, ref);
  if (res.code !== 0) {
    const detail = (res.tail || []).slice(-1)[0] ?? res.stderr.trim().split("\n").pop() ?? "unknown error";
    return passwordListResponse(
      c,
      `${del ? "Move to trash" : "Restore"} failed (exit ${res.code}): ${detail}`,
      "err",
    );
  }
  if (dryRun) {
    return passwordListResponse(
      c,
      del ? "Dry run — archive was not moved." : "Dry run — archive was not restored.",
    );
  }
  if (del) {
    await store.run("UPDATE archives SET status='deleted', updated_at=? WHERE id=?", [
      new Date().toISOString(),
      id,
    ]);
    return passwordListResponse(c, "Moved to trash.");
  }
  await store.run(
    "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE id=?",
    [new Date().toISOString(), id],
  );
  return passwordListResponse(c, "Restored — queued for the next run.");
}

actions.post("/archives/:id/delete", (c) => movePasswordArchive(c, "delete"));
actions.post("/archives/:id/restore", (c) => movePasswordArchive(c, "restore"));

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
  return c.html(`<p class="note">${esc(msg)}</p>`, 200, toastTriggerHeaders(msg));
});

// Shared wipe behind "Clear everything": deletes logs, runs and archives,
// resets the sequences, and purges stale temp dirs (dry-run aware).
// Returns the purge note.
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
    toastTriggerHeaders("Cleared logs and errors."),
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
        toastTriggerHeaders(confNotice ?? "tmp_dir is invalid", "err"),
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
      toastTriggerHeaders(confNotice ?? msg + detail, confNotice || p.failed ? "err" : "ok"),
    );
  } catch (e) {
    return c.html(
      `<p class="note err">Purge failed: ${esc(String(e))}</p>`,
      200,
      toastTriggerHeaders("Purge failed", "err"),
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
    toastTriggerHeaders("Cleared everything."),
  );
});
