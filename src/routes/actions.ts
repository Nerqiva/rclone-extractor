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
  setQueuedSkip,
  performPasswordMove,
  queuePasswordMove,
  parseConcurrency,
  MAX_CONCURRENCY,
  parseCooldownSeconds,
} from "../engine";
import { esc, toastTriggerHeaders } from "../ui";
import { normalizeRcloneConf } from "../rcloneconf";
import { Rclone, pendingRcloneConfNotice, syncConfWorkingCopy } from "../rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR } from "../tmpdir";
import { loadTmpDirSettings } from "../tmpsweep";
import { parseTrashSubdir, TRASH } from "../archive";
import { readPasswordRows, renderPasswordList } from "../passwordrows";
import { controlsFragment, configForm, queueSkipButton } from "../views";
import { EXTRA_FLAG_FIELDS, validateExtraFlags } from "../extraflags";

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
  const idRaw = form?.get("id");
  const id = idRaw === null || idRaw === undefined ? undefined : Number(idRaw);
  const archiveId = Number.isInteger(id) && (id as number) > 0 ? (id as number) : undefined;
  let ok = false;
  if (target === "listing") ok = requestSkipListing();
  else if (target === "inspection") ok = requestSkipInspection(archiveId);
  else if (target === "archive") ok = requestSkipArchive(archiveId);
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

actions.post("/run/queue-toggle", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const raw = form?.get("id");
  const id = raw === null || raw === undefined ? NaN : Number(raw);
  const skip = String(form?.get("skip") ?? "") === "1";
  const job = Number.isInteger(id) && id > 0 ? engineState.jobs.get(id) : undefined;
  if (!job || job.status !== "queued" || !setQueuedSkip(id, skip)) {
    return c.html(
      queueSkipButton(Number.isInteger(id) ? id : 0, "", false),
      200,
      toastTriggerHeaders("That archive is no longer in the queue.", "err"),
    );
  }
  return c.html(
    queueSkipButton(id, job.rel, job.queueSkipped),
    200,
    toastTriggerHeaders(
      skip ? "Archive skipped for this run." : "Archive added back to the queue.",
    ),
  );
});

const SETTING_KEYS = [
  "scan_root",
  "lsf_extra_flags",
  "archive_list_extra_flags",
  "rclonex_extract_extra_flags",
  "move_extra_flags",
  "moveto_extra_flags",
  "cat_extra_flags",
  "lsl_extra_flags",
  "lsjson_extra_flags",
  "purge_extra_flags",
  "rclone_conf",
  "queue_max",
  "concurrency",
  "retry_cooldown_seconds",
  "max_archive_size",
  "sort_by",
  "sort_dir",
  "trash_subdir",
  "tmp_dir",
];

actions.post("/config", async (c) => {
  const form = await c.req.formData();

  // Flag names cross a boundary here: check each non-empty field against the
  // installed binary before anything is written. A missing/unreadable help
  // output warns but never blocks configuration.
  const flagProblems: string[] = [];
  const flagWarnings: string[] = [];
  for (const field of EXTRA_FLAG_FIELDS) {
    const raw = form.get(field.key);
    if (raw === null) continue;
    const check = await validateExtraFlags(field, String(raw).trim());
    if (!check.ok) flagProblems.push(`${field.key}: ${check.unknown.join(", ")}`);
    else if (check.warning) flagWarnings.push(check.warning);
  }
  if (flagProblems.length) {
    const msg = `Unknown rclone flag(s): ${flagProblems.join("; ")}`;
    return c.html(
      await configForm(`<p class="note err">${esc(msg)}</p>`),
      200,
      toastTriggerHeaders(msg, "err"),
    );
  }

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
    : ((await getSetting("trash_subdir", TRASH)) ?? TRASH);
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
      : { kind: "relative" as const, value: TMP_DIR };
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
  // Extraction concurrency is bounded at the boundary; an invalid value is
  // rejected instead of silently clamped to something the user did not ask for.
  let concurrencyStored: string | undefined;
  const concurrencyRaw =
    form.get("concurrency") === null
      ? undefined
      : String(form.get("concurrency") ?? "").trim();
  if (concurrencyRaw !== undefined) {
    const parsed = parseConcurrency(concurrencyRaw);
    if (parsed === null) {
      return c.html(
        await configForm(
          `<p class="note err">concurrency must be a whole number between 1 and ${MAX_CONCURRENCY}.</p>`,
        ),
        200,
        toastTriggerHeaders("concurrency is invalid", "err"),
      );
    }
    concurrencyStored = String(parsed);
  }
  // Cooldown before retrying a failed command. Bounded whole seconds: an
  // invalid value is rejected instead of turning into a runaway wait.
  let cooldownStored: string | undefined;
  const cooldownRaw =
    form.get("retry_cooldown_seconds") === null
      ? undefined
      : String(form.get("retry_cooldown_seconds") ?? "").trim();
  if (cooldownRaw !== undefined) {
    const parsed = parseCooldownSeconds(cooldownRaw);
    if (parsed === null) {
      return c.html(
        await configForm(
          `<p class="note err">retry_cooldown_seconds must be a whole number of seconds between 0 and 86400.</p>`,
        ),
        200,
        toastTriggerHeaders("retry_cooldown_seconds is invalid", "err"),
      );
    }
    cooldownStored = String(parsed);
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
  // RcloneX archive buffer (sliding window, bytes; 0 = keep rclonex's
  // own default).
  const bufferSizeRaw =
    form.get("rclonex_archive_buffer_size") === null
      ? undefined
      : String(form.get("rclonex_archive_buffer_size") ?? "").trim();
  let rclonexBufferSizeStored: string | undefined;
  if (bufferSizeRaw !== undefined) {
    if (bufferSizeRaw === "") {
      rclonexBufferSizeStored = "0";
    } else {
      const bytes = parseSizeInput(
        bufferSizeRaw,
        String(form.get("rclonex_archive_buffer_size_unit") ?? "MB"),
      );
      if (bytes === null) {
        return c.html(
          await configForm(
            `<p class="note err">rclonex_archive_buffer_size must be a non-negative number (0 keeps rclonex's default).</p>`,
          ),
          200,
          toastTriggerHeaders("rclonex_archive_buffer_size is invalid", "err"),
        );
      }
      rclonexBufferSizeStored = String(bytes);
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
    if (key === "concurrency") continue; // stored normalized below
    if (key === "retry_cooldown_seconds") continue; // stored normalized below
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
  if (concurrencyStored !== undefined) {
    await setSetting("concurrency", concurrencyStored);
  }
  if (cooldownStored !== undefined) {
    await setSetting("retry_cooldown_seconds", cooldownStored);
  }
  await setSetting(
    "auto_skip_known",
    form.get("auto_skip_known") !== null ? "1" : "0",
  );
  await setSetting(
    "rclonex_archive_password_enabled",
    form.get("rclonex_archive_password_enabled") !== null ? "1" : "0",
  );
  if (rclonexPasswordStored !== undefined) {
    await setSetting("rclonex_archive_password", rclonexPasswordStored);
  }
  if (rclonexBufferSizeStored !== undefined) {
    await setSetting("rclonex_archive_buffer_size", rclonexBufferSizeStored);
  }
  if (normalizedConf !== null) {
    await setSetting("rclone_conf", normalizedConf);
    // Keep the working copy in sync right away so a read-only DATA_DIR is
    // reported (and toasted) on this response, not on the next run. The
    // running task (if any) is pinned to its own snapshot; this sync only
    // affects on-demand rclone calls and the next run.
    try {
      await syncConfWorkingCopy();
    } catch (e) {
      console.warn("rclone conf sync failed:", String(e));
    }
  }
  await setSetting("resume", form.get("resume") !== null ? "1" : "0");
  const confNotice = pendingRcloneConfNotice();
  const savedNote = engineState.running
    ? "Saved. Changes apply from the next run (a run in progress is not affected)."
    : "Saved.";
  const warningNote = flagWarnings.length
    ? `<p class="note warn-line">${esc(flagWarnings.join(" "))}</p>`
    : "";
  if (confNotice) {
    return c.html(
      await configForm(`${warningNote}<p class="note warn-line">${esc(confNotice)}</p>`),
      200,
      toastTriggerHeaders(confNotice, "err"),
    );
  }
  return c.html(
    await configForm(`${warningNote}<p class="note">${esc(savedNote)}</p>`),
    200,
    toastTriggerHeaders(engineState.running ? "Settings saved — applies from the next run." : "Settings saved."),
  );
});

actions.post("/config/rclone-clear", async (c) => {
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
  | { ok: true; purged: number; failed: number }
  | { ok: false }
> {
  const tmp = await loadTmpDirSettings();
  if (!tmp.spec) return { ok: false };
  const rc = await Rclone.fromSettings();
  const res = await rc.purgeStaleTemp(
    tmpRootPath(tmp.scanRoot, tmp.spec),
  );
  return { ok: true, purged: res.purged.length, failed: res.failed.length };
}

function tempPurgeNote(p: Awaited<ReturnType<typeof purgeAppTempDirs>>): string {
  if (!p.ok) return " Temp purge skipped (tmp_dir invalid).";
  return ` Purged ${p.purged} stale temp dir(s)${p.failed ? ` (${p.failed} failed)` : ""}.`;
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
// While a run is active the move is queued and applied at the next archive
// boundary; performPasswordMove re-runs every check when it finally executes.
async function movePasswordArchive(
  c: Context,
  direction: "delete" | "restore",
): Promise<Response> {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return passwordListResponse(c, "Not found.", "err");
  }
  if (engineState.running) {
    if (!queuePasswordMove(direction, id)) {
      return passwordListResponse(c, "A move for this archive is already queued.", "err");
    }
    return passwordListResponse(
      c,
      direction === "delete"
        ? "Queued — will move to trash when the current archive finishes."
        : "Queued — will restore when the current archive finishes.",
    );
  }
  const result = await performPasswordMove(direction, id);
  if (result.kind === "rejected") {
    return passwordListResponse(c, result.message, result.level);
  }
  if (result.kind === "dropped") {
    return passwordListResponse(c, "The file is no longer in the trash; the entry was removed.");
  }
  return passwordListResponse(
    c,
    result.direction === "delete" ? "Moved to trash." : "Restored — queued for the next run.",
  );
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
// resets the sequences, and purges stale temp dirs.
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
    const msg = none
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
