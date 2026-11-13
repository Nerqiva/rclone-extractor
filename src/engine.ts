import { Logger, insertLogLines } from "./log";
import { store, getSetting, setSetting } from "./db";
import { Rclone, killActiveProcs, type ExtractStats } from "./rclone";
import {
  tmpRootPath,
  tmpRunDir,
  tmpArchiveDir,
  tmpStemDir,
  tmpTopSegment,
} from "./tmpdir";
import { loadTmpDirSettings } from "./tmpsweep";
import {
  isTrashPath,
  normalizeRel,
  escapeLike,
  createArchiveStats,
  addArchiveEntry,
  classifyArchive,
  describeArchiveStats,
  stem,
  isSafeRel,
  parseTrashSubdir,
  selectExtractor,
  TRASH,
  type SkipReason,
} from "./archive";

export const engineState = {
  running: false,
  runId: 0,
  stage: "idle", // idle|listing|queueing|extracting|finished|interrupted|error
  currentRel: "",
  currentCommand: "",
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  startedAt: "",
  finishedAt: "",
  lastError: "",
  // Live progress of the rclone command currently in flight, when it emits
  // --stats (extract/move/moveto). Null for non-transfer commands (lsf,
  // archive list, purge, rmdir) and between commands.
  commandStats: null as ExtractStats | null,
  // Short human-readable label for the rclone command/phase currently in
  // flight ("Listing archives", "Extracting", ...). Drives the per-command
  // progress bar and status badge in the dashboard.
  activity: "",
  // Short app-error code for outcome='error' (no_scan_root, listing_failed,
  // ...). Shown on the progress panel after an app-caused failure.
  errorKind: "",
  // Why the user stopped the run ("stopped by user (soft|hard stop)").
  // Persisted at finalization and kept in memory so the panel can show the
  // exact reason until the page reloads (the DB has it permanently).
  interruptReason: "",
  // UI state for the stop button: stopRequested = soft stop asked (current
  // archive finishes first), forceStop = hard stop asked (rclone killed
  // immediately). Set/reset by stopEngine/forceStopEngine and runEngine.
  stopRequested: false,
  forceStop: false,
  // Temporary, per-run skip flags (never persisted to the database). Each is
  // consumed by the archive/stage in flight and does not carry over to the
  // next archive, stage, or run.
  skipListing: false,
  skipInspection: false,
  skipArchive: false,
  // True while an archive is being processed (set where last_archive is
  // persisted, cleared in the per-archive finally). Lets skip requests tell
  // "between archives" apart from "an archive is in flight".
  archiveInFlight: false,
};

function requestCancel(): void {
  engineState.stopRequested = true;
  void setSetting("cancel", "1").catch((e) =>
    console.warn("could not persist cancel flag:", String(e)),
  );
}

// Soft stop: finish the current archive, then stop.
export function stopEngine(): void {
  if (!engineState.running) return;
  requestCancel();
}

/** Hard stop: kill the in-flight rclone process immediately. */
export function forceStopEngine(): void {
  if (!engineState.running) return;
  requestCancel();
  engineState.forceStop = true;
  killActiveProcs();
}

/**
 * Stage/archive skips. Temporary and in-memory only — never persisted to the
 * database — and consumed by the one archive/stage in flight at most once.
 * Each request kills the in-flight binary (listing/archive list/extract) so
 * the engine proceeds without waiting for it to finish. Skip requests that
 * match nothing in flight are rejected so the UI can say so instead of
 * silently dropping the click.
 */
export function requestSkipListing(): boolean {
  // Allowed for the whole listing stage. If the request lands before the
  // listing binary starts (e.g. during the temp purge), the listing never
  // runs and the engine proceeds straight to the stored queue. The button
  // on the Progress page only appears while the binary is in flight, so
  // this relaxes the API guard — the UI behavior is unchanged.
  if (!engineState.running || engineState.stage !== "listing") {
    return false;
  }
  engineState.skipListing = true;
  killActiveProcs();
  return true;
}

export function requestSkipInspection(): boolean {
  if (
    !engineState.running ||
    engineState.stage !== "extracting" ||
    engineState.activity !== "Inspecting archive" ||
    !engineState.archiveInFlight
  ) {
    return false;
  }
  engineState.skipInspection = true;
  killActiveProcs();
  return true;
}

export function requestSkipArchive(): boolean {
  if (
    !engineState.running ||
    engineState.stage !== "extracting" ||
    !engineState.archiveInFlight
  ) {
    return false;
  }
  engineState.skipArchive = true;
  killActiveProcs();
  return true;
}

/**
 * Sentinel unwinding an archive the user asked to skip (re-queued, not
 * failed) — or one whose in-flight binary was killed by a hard stop (same
 * re-queue). The per-archive catch turns it back into a queued row.
 */
class ArchiveSkipRequested extends Error {
  constructor() {
    super("archive aborted (skip or hard stop)");
    this.name = "ArchiveSkipRequested";
  }
}

function throwIfSkipArchive(): void {
  if (engineState.skipArchive || engineState.forceStop) {
    throw new ArchiveSkipRequested();
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Set the in-flight command label shown by the UI; clears transfer stats. */
function setActivity(label: string): void {
  engineState.activity = label;
  engineState.commandStats = null;
}

// Narrow match for "the archive needs a password": rclonex's encryptionHint,
// rardecode's errors, and the generic encrypted-archive phrase. Anything
// else (e.g. an ISO flagged "use --archive-password") is NOT a password
// problem and must not be parked as skipped(password).
const PASSWORD_ERROR =
  /password required|incorrect password|wrong password|archive is encrypted/i;

function clampQueueMax(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? "500"));
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 100_000);
}

// Archive sizes are stored as bytes ("0" = no limit). Invalid values are
// treated as "no limit" rather than silently capping at some minimum.
function clampArchiveSize(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? "0"));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

// Reading the cancel flag once per listed line would put a database round
// trip on the hot path (and, on Postgres, a pool checkout). Poll at most
// twice a second; a stop therefore takes effect within ~500ms.
const CANCEL_CACHE_MS = 500;
let cancelCache = { at: 0, value: "0" };

function resetCancelCache(): void {
  cancelCache = { at: 0, value: "0" };
}

async function cancelRequestedCached(): Promise<boolean> {
  const nowMs = Date.now();
  if (nowMs - cancelCache.at >= CANCEL_CACHE_MS) {
    cancelCache = {
      at: nowMs,
      value: (await getSetting("cancel", "0")) ?? "0",
    };
  }
  return cancelCache.value === "1";
}

/**
 * Close runs left unfinished by a previous process and settle archives left
 * mid-extraction. With `recoverArchives` (resume on) they go back to the
 * queue; otherwise they are marked failed/killed so they never sit in
 * 'extracting' forever.
 *
 * A killed run is one the host stopped: a run row with no finish time left
 * behind by a process that did not finalize (crash, SIGKILL, OOM, or a
 * signal handler that exits early). `reason` is recorded on the run so the
 * Progress and Logs pages can show why it was killed.
 */
export async function recoverStale(
  recoverArchives = true,
  reason = "previous process exited mid-run (crash or kill)",
  excludeRunId = -1,
): Promise<number> {
  const before = await store.query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM archives WHERE status='extracting'",
  );
  const n = Number(before[0]?.c ?? 0);
  if (n > 0) {
    if (recoverArchives) {
      await store.run(
        "UPDATE archives SET status='queued', updated_at=? WHERE status='extracting'",
        [now()],
      );
    } else {
      // No binary output exists for these; store a webapp diagnostic per
      // archive so the error row's Copy/Download is not an empty 404.
      const rows = await store.query<{ id: number | string }>(
        "SELECT id FROM archives WHERE status='extracting'",
      );
      await store.run(
        "UPDATE archives SET status='failed', error_kind='killed', updated_at=? WHERE status='extracting'",
        [now()],
      );
      for (const row of rows) {
        await insertLogLines(
          { scope: "archive", refId: Number(row.id), kind: "extract" },
          ["killed: app stopped before extraction finished"],
        ).catch(() => {});
      }
    }
  }
  // A run row with no finish time is a run from a previous process. Close it so
  // the logs page and progress panel do not show it as indefinitely running,
  // and leave a log line behind so the interruption and its cause are visible
  // in both the main and the errors log (nothing else survives a crash).
  // excludeRunId keeps the caller's own freshly created row out of this.
  const stale = await store.query<{ id: number | string }>(
    "SELECT id FROM runs WHERE finished_at IS NULL AND id != ?",
    [excludeRunId],
  );
  await store.run(
    "UPDATE runs SET finished_at=?, outcome='killed', interrupted=1, interrupted_reason=?, error_kind='killed' WHERE finished_at IS NULL AND id != ?",
    [now(), reason, excludeRunId],
  );
  for (const row of stale) {
    const refId = Number(row.id);
    await insertLogLines(
      { scope: "run", refId, kind: "main" },
      [`[killed] ${reason}`],
    ).catch(() => {});
    await insertLogLines(
      { scope: "run", refId, kind: "errors" },
      [`[killed] ${reason}`],
    ).catch(() => {});
  }
  return n;
}

export async function runEngine(
  opts: { reuseScan?: boolean } = {},
): Promise<void> {
  if (engineState.running) return;
  engineState.running = true;
  engineState.lastError = "";
  engineState.runId = 0;
  engineState.currentRel = "";
  engineState.currentCommand = "";
  engineState.total = 0;
  engineState.done = 0;
  engineState.failed = 0;
  engineState.skipped = 0;
  engineState.startedAt = "";
  engineState.finishedAt = "";
  engineState.commandStats = null;
  engineState.activity = "";
  engineState.stopRequested = false;
  engineState.forceStop = false;
  engineState.errorKind = "";
  engineState.interruptReason = "";
  engineState.skipListing = false;
  engineState.skipInspection = false;
  engineState.skipArchive = false;
  engineState.archiveInFlight = false;

  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  // Validate tmp_dir up front so misconfiguration fails fast instead of
  // producing a half-extracted archive outside the expected tree.
  const trashRaw = (await getSetting("trash_subdir", TRASH)) ?? TRASH;
  const trashSubdirValidated = parseTrashSubdir(trashRaw);
  const tmpSettings = trashSubdirValidated
    ? await loadTmpDirSettings(trashSubdirValidated)
    : null;
  const tmpSpec = tmpSettings?.spec ?? null;

  let runRowId = 0;
  let logger: Logger | null = null;
  let errorLog: Logger | null = null;
  let errorKind = "engine_error";

  const fail = (msg: string, detail?: string) => {
    logger?.error(msg, detail);
    errorLog?.error(msg, detail);
  };
  const warn = (msg: string) => {
    logger?.warn(msg);
    errorLog?.warn(msg);
  };

  // App errors — before or after the run row exists — close the run with
  // outcome='error' and a short error code, and leave log lines behind, so
  // they never masquerade as a finish or a host kill.
  const abortWithError = async (code: string, msg: string) => {
    errorKind = code;
    engineState.errorKind = code;
    engineState.stage = "error";
    engineState.lastError = msg;
    engineState.finishedAt = now();
    fail(`engine error code=${code}: ${msg}`);
    if (runRowId) {
      await store
        .run(
          "UPDATE runs SET finished_at=?, outcome='error', error_kind=?, interrupted=0, interrupted_reason=? WHERE id=?",
          [engineState.finishedAt, code, msg, runRowId],
        )
        .catch((e) =>
          console.error("could not finalize errored run:", String(e)),
        );
    }
    await logger?.flush();
    await errorLog?.flush();
    engineState.running = false;
  };

  // Create the run row and logger up front so even a pre-flight failure
  // (missing scan_root, bad trash_subdir/tmp_dir) persists with a code and
  // shows up on the Logs page after a reload.
  const startedAt = now();
  try {
    runRowId = await store.insertReturningId(
      "INSERT INTO runs(started_at, total) VALUES(?, 0)",
      [startedAt],
    );
  } catch (e) {
    // The database is unreachable; nothing can be persisted. Surface
    // in-memory only.
    console.error("could not create run row:", String(e));
    engineState.stage = "error";
    engineState.lastError = String(e);
    engineState.finishedAt = now();
    engineState.running = false;
    return;
  }
  await setSetting("last_run_id", String(runRowId));
  logger = new Logger({ scope: "run", refId: runRowId, kind: "main" });
  errorLog = new Logger({ scope: "run", refId: runRowId, kind: "errors" });
  logger.info(`run ${runRowId} started`);
  engineState.runId = runRowId;
  engineState.startedAt = startedAt;

  if (!scanRoot) {
    await abortWithError("no_scan_root", "scan_root not set");
    return;
  }
  if (!trashSubdirValidated) {
    await abortWithError("invalid_trash_subdir", `trash_subdir is invalid: ${trashRaw}`);
    return;
  }
  if (!tmpSpec) {
    await abortWithError(
      "invalid_tmp_dir",
      `tmp_dir is invalid: ${tmpSettings?.raw ?? "?"}`,
    );
    return;
  }

  await setSetting("cancel", "0");
  resetCancelCache();

  try {
    const resumeEnabled = (await getSetting("resume", "1")) === "1";
    const recovered = await recoverStale(resumeEnabled, undefined, runRowId);
    if (recovered > 0) {
      console.log(
        resumeEnabled
          ? `resumed ${recovered} stale archive(s)`
          : `marked ${recovered} killed archive(s) as failed`,
      );
    }

    engineState.stage = "listing";
    logger.info(`scan_root=${scanRoot}`);

    const rc = await Rclone.fromSettings(logger);
    // Persist every command dispatch so a crash/kill leaves the in-flight
    // command behind for the Progress page. Fire-and-forget: a command must
    // never wait on (or fail because of) this bookkeeping write.
    const persistCommand = (command: string) => {
      engineState.currentCommand = command;
      void store
        .run("UPDATE runs SET last_command=? WHERE id=?", [command, runRowId])
        .catch(() => {});
    };
    rc.onCommand = persistCommand;

    // Absolute when tmp_dir is a remote/local path; inside root otherwise.
    const tmpRoot = tmpRootPath(scanRoot, tmpSpec);
    const tmpTop = tmpTopSegment(tmpSpec);
    // tmpSettings is non-null here: an invalid tmp_dir already aborted above.
    const dryRunNow = tmpSettings?.dryRun ?? false;
    setActivity("Purging stale temp");
    try {
      const res = await rc.purgeStaleTemp(tmpRoot, dryRunNow);
      if (res.purged.length) {
        const verb = dryRunNow ? "would purge (dry run)" : "purged";
        logger.info(
          `${verb} ${res.purged.length} stale temp dir(s): ${res.purged.join(", ")}`,
        );
      }
      if (res.failed.length) {
        logger.warn(`could not purge temp dir(s): ${res.failed.join(", ")}`);
      }
      if (res.skipped.length) {
        logger.info(`kept non-app temp entries: ${res.skipped.join(", ")}`);
      }
    } catch (e) {
      logger.warn(`temp sweep failed: ${e}`);
    } finally {
      setActivity("");
    }

    const queueMax = clampQueueMax(await getSetting("queue_max", "500"));
    const maxArchiveSize = clampArchiveSize(
      await getSetting("max_archive_size", "0"),
    );
    const minArchiveSize = clampArchiveSize(
      await getSetting("min_archive_size", "0"),
    );
    const rclonexEnabled = (await getSetting("rclonex", "0")) === "1";
    const rclonexSkipInspection =
      (await getSetting("rclonex_skip_inspection", "1")) === "1";
    // RcloneX-specific extraction flags (default off). A stored archive
    // password is only passed when its checkbox enabled it.
    const rclonexPasswordEnabled =
      (await getSetting("rclonex_archive_password_enabled", "0")) === "1";
    const rclonexPassword =
      (await getSetting("rclonex_archive_password", "")) ?? "";
    // Sliding-window buffer for random-access formats read by rclonex
    // (7Z, ISO) — stored as bytes; 0 disables the override (rclonex keeps
    // its own default).
    const rclonexBufferSize = Number(
      await getSetting("rclonex_archive_buffer_size", "16777216"),
    );
    const rclonexFlags: string[] = [];
    if (rclonexPasswordEnabled && rclonexPassword) {
      rclonexFlags.push("--archive-password", rclonexPassword);
    }
    if (rclonexBufferSize > 0) {
      if (Number.isFinite(rclonexBufferSize)) {
        rclonexFlags.push(
          "--archive-window-size",
          String(Math.floor(rclonexBufferSize)),
        );
      } else {
        logger.warn(
          `rclonex_archive_buffer_size is invalid (${await getSetting("rclonex_archive_buffer_size", "")}); the buffer override is ignored`,
        );
      }
    }
    const autoSkipKnown = (await getSetting("auto_skip_known", "1")) === "1";
    const dryRun = (await getSetting("dry_run", "0")) === "1";
    const trashSubdir = trashSubdirValidated;
    const trashDir = normalizeRel(trashSubdir);
    // Fingerprint of every setting that changes what a listing produces or
    // how paths get inserted during one. The cached-scan marker is only
    // reused when the current fingerprint matches exactly, so changing any
    // of these forces a fresh scan instead of silently reusing stale cache.
    const scanFingerprint = [
      scanRoot,
      String(maxArchiveSize),
      String(minArchiveSize),
      String(queueMax),
      dryRun ? "1" : "0",
      trashDir,
      autoSkipKnown ? "1" : "0",
      rclonexEnabled ? "1" : "0",
    ].join("|");
    // Validate cached scan results for the "Reuse Previous Scan Results"
    // option: a complete marker with a matching fingerprint only, plus the
    // regular queue guards below. Anything stale/incomplete/mismatched falls
    // back to a fresh scan.
    const cacheKey = (await getSetting("scan_cache_key", "")) ?? "";
    const cacheState =
      (await getSetting("scan_cache_state", "incomplete")) ?? "";
    const reuseRequested = opts.reuseScan === true;
    const reuseScan =
      reuseRequested && cacheState === "complete" && cacheKey === scanFingerprint;
    if (reuseRequested && !reuseScan) {
      logger.info(
        "reuse-scan requested but no valid cached scan for these settings; scanning fresh",
      );
    }
    const existing = new Map(
      (
        await store.query<{
          path: string;
          status: string;
          error_kind: string | null;
        }>("SELECT path, status, error_kind FROM archives")
      ).map((row) => [row.path, row]),
    );

    let queued = 0;
    let skippedUnsafe = 0;
    let ignoredTooLarge = 0;
    let ignoredTooSmall = 0;
    const createdAt = now();
    setActivity(reuseScan ? "Reusing cached scan" : "Listing archives");
    // A skip asked before the listing even starts (e.g. during the temp
    // purge) short-circuits it entirely — no process is spawned.
    const skipListingAtStart = engineState.skipListing;
    const listed =
      reuseScan || skipListingAtStart
        ? null
        : await rc.list(async (rel, size) => {
      if (engineState.skipListing) return false;
      if (await cancelRequestedCached()) return false;
      // A hostile or corrupt remote could return paths that escape the scan
      // tree ("..", absolute paths, empty segments). Never touch those.
      if (!isSafeRel(rel)) {
        skippedUnsafe++;
        return;
      }
      // Archives already sitting in the trash subdir are not queued again;
      // otherwise a done path there would be re-queued on every run.
      if (isTrashPath(rel, trashSubdir)) return;
      // Archives outside the configured size window are ignored entirely:
      // never queued, not stored, and re-evaluated on the next run.
      if (maxArchiveSize > 0 && size > maxArchiveSize) {
        ignoredTooLarge++;
        return;
      }
      if (minArchiveSize > 0 && size < minArchiveSize) {
        ignoredTooSmall++;
        return;
      }
      if (queued >= queueMax) return false;

      const prev = existing.get(rel);
      if (!prev) {
        await store.run(
          "INSERT OR IGNORE INTO archives(path, size, status, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?)",
          [rel, size, createdAt, createdAt],
        );
        existing.set(rel, { path: rel, status: "queued", error_kind: null });
        queued++;
        return;
      }

      // A done path that is visible again is a new upload (the previous file
      // was moved to trash). Re-queue it. When the user opted out of
      // auto-skipping archives previously classified as torrent/website dumps,
      // those are re-queued too (for re-inspection). In dry-run neither is
      // re-queued, or every run would redo the same work.
      const knownSkip =
        prev.status === "skipped" &&
        (prev.error_kind === "torrent" || prev.error_kind === "website");
      const shouldRequeue =
        !dryRun && (prev.status === "done" || (!autoSkipKnown && knownSkip));
      if (shouldRequeue) {
        await store.run(
          "UPDATE archives SET size=?, status='queued', error_kind=NULL, updated_at=? WHERE path=?",
          [size, now(), rel],
        );
        existing.set(rel, { path: rel, status: "queued", error_kind: null });
        queued++;
      }
    });

    if (skippedUnsafe > 0) {
      warn(`listing skipped ${skippedUnsafe} unsafe path(s) from the remote`);
    }
    if (ignoredTooLarge > 0) {
      logger.info(
        `listing ignored ${ignoredTooLarge} archive(s) above max_archive_size`,
      );
    }
    if (ignoredTooSmall > 0) {
      logger.info(
        `listing ignored ${ignoredTooSmall} archive(s) below min_archive_size`,
      );
    }
    if (!listed) {
      if (engineState.skipListing) {
        engineState.skipListing = false;
        logger.info("listing skipped by user");
        await setSetting("scan_cache_state", "incomplete");
      } else {
        logger.info("reused cached scan results; listing skipped");
      }
    } else {
      // A skip aborts the listing early; it is not a cache-worthy listing.
      const skipConsumed = engineState.skipListing;
      if (skipConsumed) {
        engineState.skipListing = false;
        logger.info("listing skipped by user");
        await setSetting("scan_cache_state", "incomplete");
      }
      if (!skipConsumed && listed.streamError) {
        await setSetting("scan_cache_state", "incomplete");
        const cancelRequested =
          engineState.forceStop || (await getSetting("cancel", "0")) === "1";
        // A force-stopped listing is an intentional stop, not a failure.
        if (!cancelRequested) {
          const msg = "listing stream failed";
          errorKind = "listing_failed";
          fail(
            msg,
            `$ ${listed.command}\n${listed.streamError}\n${listed.stderr}`.trim(),
          );
          throw new Error(`${msg}: ${listed.streamError}`);
        }
        logger.info("listing stopped by user");
      } else if (!skipConsumed && listed.stopped) {
        await setSetting("scan_cache_state", "incomplete");
        logger.info("listing stopped early (queue limit or cancel)");
      } else if (!skipConsumed && listed.code !== 0) {
        await setSetting("scan_cache_state", "incomplete");
        // A hard stop kills the listing process; a non-zero exit then means
        // the user interrupted the run, not that the remote broke.
        const cancelRequested =
          engineState.forceStop || (await getSetting("cancel", "0")) === "1";
        if (cancelRequested) {
          logger.info("listing stopped by user");
        } else {
          const msg = `listing failed (exit ${listed.code})`;
          errorKind = "listing_failed";
          fail(msg, `$ ${listed.command}\n${listed.stderr}`.trim());
          throw new Error(msg);
        }
      } else if (!skipConsumed) {
        // The listing ran to completion; cache it for "Reuse Previous Scan
        // Results". The archive table is never rewritten or corrupted by
        // this, only the marker settings are stored.
        await setSetting("scan_cache_key", scanFingerprint);
        await setSetting("scan_cache_state", "complete");
      }
      if (listed.stderr.trim()) {
        warn(`listing stderr: ${listed.stderr.trim()}`);
      }
      logger.info(`listing complete: ${queued} new/requeued archive(s)`);
    }

    engineState.stage = "queueing";
    setActivity("Building queue");
    const sortBy = (await getSetting("sort_by", "path")) === "size" ? "size" : "path";
    const sortDir = (await getSetting("sort_dir", "asc")) === "desc" ? "DESC" : "ASC";
    // Exclude pre-existing queued rows that live in the trash subdir (e.g.
    // enqueued by an older version), so they are never processed.
    // Archives outside the configured size window that were queued before the
    // limits were set stay queued but are not selected; relaxing the limit
    // makes them eligible again.
    const sizeGuards =
      (maxArchiveSize > 0 ? " AND size <= ?" : "") +
      (minArchiveSize > 0 ? " AND size >= ?" : "");
    const queueWhere = trashDir
      ? `WHERE status='queued' AND path <> ? AND path NOT LIKE ? ESCAPE '\\'${sizeGuards}`
      : `WHERE status='queued'${sizeGuards}`;
    const queueParams: unknown[] = trashDir
      ? [trashDir, `${escapeLike(trashDir)}/%`]
      : [];
    if (maxArchiveSize > 0) queueParams.push(maxArchiveSize);
    if (minArchiveSize > 0) queueParams.push(minArchiveSize);
    const rows = await store.query<{ id: number; path: string; size: number }>(
      `SELECT id, path, size FROM archives ${queueWhere} ORDER BY ${sortBy} ${sortDir} LIMIT ?`,
      [...queueParams, queueMax],
    );

    await store.run("UPDATE runs SET total=? WHERE id=?", [rows.length, runRowId]);
    engineState.total = rows.length;
    logger.info(`queue size ${rows.length}`);

    engineState.stage = "extracting";
    setActivity("");

    // One runner per binary; rclonex is only created when enabled. Both share
    // the --config working copy and remote flags. The dashboard "Active
    // command" shows commands from either binary.
    const wireCommand = (instance: Rclone) => {
      instance.onCommand = persistCommand;
    };
    const rclonexRc = rclonexEnabled
      ? await Rclone.fromSettings(logger, { rclonex: true })
      : null;
    if (rclonexRc) wireCommand(rclonexRc);

    for (const row of rows) {
      // A pending skip click between archives has no archive in flight:
      // discard it rather than leaking onto the next archive. Mid-archive
      // skips are consumed by that archive's guard and cleared in the catch.
      engineState.skipArchive = false;
      engineState.skipInspection = false;
      if (await cancelRequestedCached()) {
        logger.info("cancel requested, stopping");
        engineState.stage = "interrupted";
        break;
      }
      // Clear-queues maintenance may have deleted this row while the run
      // was in flight; skip it instead of processing a stale entry.
      const current = await store.get1<{ status: string }>(
        "SELECT status FROM archives WHERE id=?",
        [row.id],
      );
      if (!current || current.status !== "queued") {
        logger.info(`skipping ${row.path} (queue cleared)`);
        continue;
      }

      const rel = row.path;
      // Defense in depth: rows enqueued by older versions could hold paths
      // that are unsafe to pass to rclone. Fail them instead of executing.
      if (!isSafeRel(rel)) {
        await store.run(
          "UPDATE archives SET status='failed', error_kind='unsafe_path', updated_at=? WHERE id=?",
          [now(), row.id],
        );
        // No binary output exists; store the webapp diagnostic so the
        // error row's Copy/Download shows something instead of a 404.
        await insertLogLines(
          { scope: "archive", refId: row.id, kind: "extract" },
          [`unsafe archive path rejected by app: ${JSON.stringify(rel)}`],
        ).catch(() => {});
        warn(`skipped unsafe stored path: ${JSON.stringify(rel)}`);
        engineState.failed++;
        await store.run("UPDATE runs SET done=?, failed=?, skipped=? WHERE id=?", [
          engineState.done,
          engineState.failed,
          engineState.skipped,
          runRowId,
        ]);
        continue;
      }
      engineState.currentRel = rel;
      engineState.commandStats = null;
      engineState.activity = "";
      engineState.archiveInFlight = true;
      // Persist before the first binary starts so a crash/kill still leaves
      // "which archive was in flight" behind for the Progress page.
      void store
        .run("UPDATE runs SET last_archive=? WHERE id=?", [rel, runRowId])
        .catch(() => {});
      await store.run(
        "UPDATE archives SET status='extracting', updated_at=? WHERE id=?",
        [now(), row.id],
      );

      const baseName = rel.slice(rel.lastIndexOf("/") + 1);
      const useRclonex =
        rclonexRc !== null && selectExtractor(baseName, true) === "rclonex";
      const extractor = useRclonex && rclonexRc ? rclonexRc : rc;
      const tmp = tmpStemDir(tmpRoot, runRowId, row.id, stem(baseName));
      const archiveTmpDir = tmpArchiveDir(tmpRoot, runRowId, row.id);
      const ref = { scope: "archive" as const, refId: row.id, kind: "extract" as const };
      let result: "done" | "failed" | "skipped" = "failed";
      let tmpAttempted = false;

      try {
        // Inspect the archive before any extraction happens. Archives that
        // match the skip rules (empty, torrent, website, tiny) or cannot be
        // read are skipped and never extracted. For RcloneX-handled formats
        // the inspection is skipped by default (rclonex does not implement
        // `archive list` for rar/7z/iso) unless the user enabled it — then it
        // goes through the same binary selected for extraction. The
        // inspection-skip setting applies consistently to every archive of
        // those formats; a per-archive user skip applies only to this one.
        const stats = createArchiveStats();
        let inspectionDetail: string | null = null;
        let skipReason: SkipReason | "unreadable" | "password" | null = null;
        if (engineState.skipInspection) {
          engineState.skipInspection = false; // consumed by this archive only
          logger.info(`inspection skipped by user: ${rel}`);
        } else if (useRclonex && rclonexSkipInspection) {
          logger.info(`skipping archive inspection for ${rel} (rclonex)`);
        } else if (useRclonex && /\.iso$/i.test(baseName)) {
          // mholt/archives cannot list ISO (identified only on the extract
          // path), so rclone's `archive list` would always fail here — and
          // "unreadable" would park the archive forever. Skip instead.
          logger.info(`skipping inspection for ${rel} (ISO archives are not listable)`);
        } else {
          // Inspection always goes through the rclone binary: upstream's
          // `archive list` reads RAR/7Z fine, rclonex does not extend it and
          // would only add a full-stream re-read.
          setActivity("Inspecting archive");
          const listOut = await rc.archiveList(rel, ref, (entry) =>
            addArchiveEntry(stats, entry.path, entry.size),
          );
          // Skip-archive takes precedence over the inspection outcome:
          // re-queue the archive instead of classifying/extracting it.
          throwIfSkipArchive();
          setActivity("");
          if (engineState.skipInspection) {
            // The user asked to skip while the listing was in flight; treat
            // the inspection as passed for this archive only.
            engineState.skipInspection = false;
            logger.info(`inspection skipped by user: ${rel}`);
          } else {
            const listFailed =
              Boolean(listOut.streamError) || listOut.code !== 0;
            if (listFailed) {
              skipReason = PASSWORD_ERROR.test(listOut.stderr)
                ? "password"
                : "unreadable";
              inspectionDetail = `listing failed (exit ${listOut.code})`;
            } else {
              skipReason = classifyArchive(stats);
              inspectionDetail = describeArchiveStats(stats);
            }
          }
        }

        if (skipReason) {
          const detail = inspectionDetail ?? describeArchiveStats(stats);
          await store.run(
            "UPDATE archives SET status='skipped', error_kind=?, updated_at=? WHERE id=?",
            [skipReason, now(), row.id],
          );
          // Webapp-made diagnosis (no binary output is produced for skip
          // classifications); store it so Copy/Download on the error row is
          // not an empty 404.
          await insertLogLines(ref, [`skipped (${skipReason}): ${detail}`]).catch(
            () => {},
          );
          warn(`skipped (${skipReason}): ${rel} [${detail}]`);
          result = "skipped";
        } else {
        tmpAttempted = true;
        setActivity("Extracting");
        const ex = await extractor.extract(
          rel,
          tmp,
          dryRun,
          ref,
          (stats) => {
            engineState.commandStats = stats;
          },
          useRclonex ? rclonexFlags : undefined,
        );
        setActivity("");
        throwIfSkipArchive();

        if (ex.code !== 0) {
          const all = `${ex.tail.join("\n")}\n${ex.stderr}`;
          if (PASSWORD_ERROR.test(all)) {
            await store.run(
              "UPDATE archives SET status='skipped', error_kind='password', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            await insertLogLines(ref, [
              `skipped (password): extraction failed (exit ${ex.code})`,
            ]).catch(() => {});
            warn(`skipped (password): ${rel} [$ ${ex.command}]`);
            result = "skipped";
          } else {
            setActivity("Cleaning up");
            await rc.cleanup(tmp, dryRun, ref);
            setActivity("");
            throwIfSkipArchive();
            await store.run(
              "UPDATE archives SET status='failed', error_kind='extract', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            fail(
              `extract failed: ${rel}`,
              `$ ${ex.command}\n${ex.tail.join("\n")}`.trim(),
            );
          }
        } else {
          // Post-extraction inspection for rclonex-handled formats: the
          // archive itself cannot be cheaply listed, but the extracted
          // tree can. Website dumps and torrent collections are skipped
          // after extraction — the extracted data is removed and the
          // archive stays in place (never promoted, never trashed).
          // Anything else continues as a normal extraction.
          let postSkip: "website" | "torrent" | null = null;
          const exStats = createArchiveStats();
          if (useRclonex && !dryRun) {
            setActivity("Inspecting extracted files");
            const listOut = await rc.listPath(tmp, (p, size) =>
              addArchiveEntry(exStats, p, size),
            );
            setActivity("");
            throwIfSkipArchive();
            if (listOut.code !== 0 && exStats.total === 0) {
              warn(
                `post-extraction listing failed for ${rel} [$ ${listOut.command}]; continuing`,
              );
            } else if (exStats.total > 0) {
              const reason = classifyArchive(exStats);
              if (reason === "website" || reason === "torrent") {
                postSkip = reason;
              }
            }
          }
          if (postSkip) {
            setActivity("Cleaning up");
            const purged = await rc.purge(archiveTmpDir, dryRun, ref);
            setActivity("");
            if (purged.code !== 0) {
              warn(
                `temp purge failed: ${archiveTmpDir} [$ ${purged.command}] ${purged.stderr.trim() || "unknown error"}`,
              );
            }
            await store.run(
              "UPDATE archives SET status='skipped', error_kind=?, updated_at=? WHERE id=?",
              [postSkip, now(), row.id],
            );
            await insertLogLines(ref, [
              `skipped (${postSkip}): extracted tree [${describeArchiveStats(exStats)}]`,
            ]).catch(() => {});
            warn(`skipped (${postSkip}): ${rel} [extracted tree]`);
            result = "skipped";
          } else {
          setActivity("Moving to destination");
          const promoted = await rc.promote(rel, tmp, dryRun, ref, tmpTop, (stats) => {
            engineState.commandStats = stats;
          });
          setActivity("");
          throwIfSkipArchive();
          if (promoted.code !== 0) {
            setActivity("Cleaning up");
            await rc.cleanup(tmp, dryRun, ref);
            setActivity("");
            throwIfSkipArchive();
            await store.run(
              "UPDATE archives SET status='failed', error_kind='promote', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            fail(
              `promote failed: ${rel}`,
              `$ ${promoted.command}\n${promoted.tail.join("\n")}`.trim(),
            );
          } else {
            setActivity("Cleaning up");
            const cleaned = await rc.cleanup(tmp, dryRun, ref);
            setActivity("");
            if (cleaned.code !== 0) {
              warn(
                `cleanup failed: ${rel} [$ ${cleaned.command}] ${cleaned.stderr.trim()}`,
              );
            }
            // A skip asked while the cleanup ran must not move the archive to
            // trash — without this guard the archive was extracted, promoted
            // and trashed, then re-queued anyway.
            throwIfSkipArchive();

            setActivity("Moving to trash");
            const trashed = await rc.trash(rel, trashSubdir, dryRun, ref, (stats) => {
              engineState.commandStats = stats;
            });
            setActivity("");
            throwIfSkipArchive();
            if (trashed.code !== 0) {
              await store.run(
                "UPDATE archives SET status='failed', error_kind='trash', updated_at=? WHERE id=?",
                [now(), row.id],
              );
              fail(
                `trash failed: ${rel}`,
                `$ ${trashed.command}\n${trashed.tail.join("\n")}`.trim(),
              );
            } else {
              await store.run(
                "UPDATE archives SET status='done', error_kind=NULL, updated_at=? WHERE id=?",
                [now(), row.id],
              );
              logger.info(`done: ${rel}`);
              result = "done";
            }
          }
          }
        }
        }
      } catch (e) {
        if (e instanceof ArchiveSkipRequested) {
          // User skip or hard stop: put the archive back in the queue (like a
          // force-stop) and count it as skipped for this run. Done and skipped
          // rows are never resurrected.
          engineState.skipArchive = false; // consumed by this archive
          await store.run(
            "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE id=? AND status NOT IN ('done','skipped')",
            [now(), row.id],
          );
          if (engineState.forceStop) {
            logger.info(`hard stop — re-queued: ${rel}`);
          } else {
            warn(`skipped by user (re-queued): ${rel}`);
          }
          result = "skipped";
        } else {
        await store.run(
          "UPDATE archives SET status='failed', error_kind='spawn', updated_at=? WHERE id=?",
          [now(), row.id],
        );
        // No binary output exists when the webapp itself throws (spawn
        // failure, DB error, ...); store the diagnostic so the error row's
        // Copy/Download is not empty.
        await insertLogLines(ref, [`archive error: ${String(e)}`]).catch(() => {});
        fail(`archive error: ${rel}`, String(e));
        }
      } finally {
        engineState.archiveInFlight = false;
        if (engineState.forceStop) {
          // Hard stop while the archive was mid-flight: put it back in the
          // queue instead of counting it as done/failed/skipped, so it is
          // picked up again on the next run. Never resurrect an archive
          // whose terminal state (done/skipped) already committed. The
          // clear error_kind drops any half-written failure from the aborted
          // attempt so it never shows up as a bogus error row.
          await store.run(
            "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE id=? AND status NOT IN ('done', 'skipped')",
            [now(), row.id],
          );
          engineState.currentCommand = "";
          engineState.commandStats = null;
          engineState.activity = "";
        } else {
          if (result === "done") engineState.done++;
          else if (result === "skipped") engineState.skipped++;
          else engineState.failed++;
          engineState.currentCommand = "";
          engineState.commandStats = null;
          engineState.activity = "";
          await store.run("UPDATE runs SET done=?, failed=?, skipped=? WHERE id=?", [
            engineState.done,
            engineState.failed,
            engineState.skipped,
            runRowId,
          ]);
        }
        // Best effort: remove the per-archive temp dir with whatever is
        // left in it. `rmdir` refuses non-empty dirs, which would leak
        // partial extractions — purge instead. Only ever called on the
        // app-owned archive dir.
        if (tmpAttempted) {
          setActivity("Cleaning up");
          const purged = await rc.purge(archiveTmpDir, dryRun, ref);
          setActivity("");
          if (purged.code !== 0) {
            warn(
              `temp purge failed: ${archiveTmpDir} [$ ${purged.command}] ${purged.stderr.trim() || "unknown error"}`,
            );
          }
        }
      }
    }

    // Best effort: remove the now-possibly-empty run-level temp dir. If it
    // still holds extracted data (e.g. an archive was force-stopped
    // mid-flight), purge only that exact directory — never the shared
    // temp root, which may hold other runs' data that the app must not
    // delete.
    setActivity("Cleaning up");
    const tmpRootNorm = tmpRoot.replace(/\/+$/, "");
    const runDir = tmpRunDir(tmpRootNorm, runRowId);
    const tmpRootIsSafe =
      tmpRootNorm.length > 1 &&
      tmpRootNorm !== "/" &&
      !tmpRootNorm.endsWith(":") &&
      !/^[A-Za-z]:[\\/]?$/.test(tmpRootNorm) &&
      runDir === tmpRunDir(tmpRootNorm, runRowId);
    const runRes = await rc.rmdir(runDir, dryRun);
    if (runRes.code !== 0) {
      if (tmpRootIsSafe) {
        const purged = await rc.purge(runDir, dryRun);
        if (purged.code === 0) {
          logger.info(`purged ${runDir} (not empty)`);
        } else {
          logger.info(`left ${runDir} in place (${purged.stderr.trim() || "not empty"})`);
        }
      } else {
        logger.info(`left ${runDir} in place (temp root not safe to purge)`);
      }
    }
    // The shared temp root itself is only removed when already empty.
    const rootRes = await rc.rmdir(tmpRootNorm, dryRun);
    if (rootRes.code !== 0) {
      logger.info(`left ${tmpRootNorm} in place (not empty)`);
    }
    setActivity("");

    // A stop requested while the last archive was being processed never gets
    // another loop iteration to notice it, so decide here. A user-stopped run
    // ends as outcome='interrupted' (reason names the stop mode); a clean run
    // ends as 'finished'.
    if (engineState.stage !== "interrupted") {
      engineState.stage = engineState.stopRequested ? "interrupted" : "finished";
    }
    engineState.finishedAt = now();
    const stopped = engineState.stage === "interrupted";
    // A stop the engine asked for itself (stopEngine sets stopRequested) is a
    // user stop; one it only noticed via the cancel setting is an external
    // cancel — say which, with a specific code.
    const stopCode = stopped
      ? engineState.forceStop
        ? "interrupted_hard"
        : engineState.stopRequested
          ? "interrupted_soft"
          : "interrupted_cancel"
      : null;
    engineState.interruptReason = stopped
      ? engineState.forceStop
        ? "stopped by user (hard stop)"
        : engineState.stopRequested
          ? "stopped by user (soft stop)"
          : "cancel requested via settings"
      : "";
    engineState.errorKind = stopCode ?? "";
    if (stopCode) {
      const line = `[${stopCode}] ${engineState.interruptReason}`;
      await insertLogLines({ scope: "run", refId: runRowId, kind: "main" }, [
        line,
      ]).catch(() => {});
      await insertLogLines({ scope: "run", refId: runRowId, kind: "errors" }, [
        line,
      ]).catch(() => {});
    }
    await store.run(
      "UPDATE runs SET finished_at=?, outcome=?, interrupted=?, interrupted_reason=?, error_kind=? WHERE id=?",
      [
        engineState.finishedAt,
        stopped ? "interrupted" : "finished",
        stopped ? 1 : 0,
        stopped ? engineState.interruptReason : null,
        stopCode,
        runRowId,
      ],
    );
    logger.info(
      `run ${runRowId} ${engineState.stage}: done=${engineState.done} failed=${engineState.failed} skipped=${engineState.skipped}`,
    );
  } catch (e) {
    await abortWithError(errorKind, String(e));
  } finally {
    // Let queued log writes land before the run state resets and (on
    // shutdown) the database closes.
    await logger?.flush();
    await errorLog?.flush();
    engineState.running = false;
    engineState.currentRel = "";
    engineState.currentCommand = "";
    engineState.commandStats = null;
    engineState.activity = "";
    engineState.stopRequested = false;
    engineState.forceStop = false;
    engineState.skipListing = false;
    engineState.skipInspection = false;
    engineState.skipArchive = false;
    engineState.archiveInFlight = false;
  }
}
