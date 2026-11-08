import { Logger } from "./log";
import { store, getSetting, setSetting } from "./db";
import { Rclone, killActiveProcs, type ExtractStats } from "./rclone";
import {
  tmpRootPath,
  tmpRunDir,
  tmpArchiveDir,
  tmpStemDir,
  tmpTopSegment,
  parseTmpDir,
  TMP_DIR_DEFAULT,
} from "./tmpdir";
import {
  isTrashPath,
  normalizeRel,
  escapeLike,
  createArchiveStats,
  addArchiveEntry,
  classifyArchive,
  describeArchiveStats,
  stem,
  type SkipReason,
} from "./archive";

export const engineState = {
  running: false,
  runId: 0,
  stage: "idle", // idle|listing|queueing|extracting|finished|cancelled|error
  currentRel: "",
  currentCommand: "",
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  startedAt: "",
  finishedAt: "",
  lastError: "",
  scanRoot: "",
  extractStats: null as ExtractStats | null,
  // UI state for the stop button: stopRequested = soft stop asked (current
  // archive finishes first), forceStop = hard stop asked (rclone killed
  // immediately). Set/reset by stopEngine/forceStopEngine and runEngine.
  stopRequested: false,
  forceStop: false,
};

/** Soft stop: finish the current archive, then stop. */
export function stopEngine(): void {
  if (!engineState.running) return;
  engineState.stopRequested = true;
  void setSetting("cancel", "1");
}

/** Hard stop: kill the in-flight rclone process immediately. */
export function forceStopEngine(): void {
  if (!engineState.running) return;
  engineState.stopRequested = true;
  engineState.forceStop = true;
  void setSetting("cancel", "1");
  killActiveProcs();
}

function now(): string {
  return new Date().toISOString();
}

function clampQueueMax(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? "500"));
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 100_000);
}

/**
 * Close runs left unfinished by a crash and, when `recoverArchives` is on,
 * reset archives left mid-extraction back to the queue.
 */
export async function recoverStale(recoverArchives = true): Promise<number> {
  let n = 0;
  if (recoverArchives) {
    const before = await store.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM archives WHERE status='extracting'",
    );
    n = Number(before[0]?.c ?? 0);
    if (n > 0) {
      await store.run("UPDATE archives SET status='queued' WHERE status='extracting'");
    }
  }
  // A run row with no finish time is a run from a previous process. Close it so
  // the logs page and progress panel do not show it as indefinitely running.
  await store.run(
    "UPDATE runs SET finished_at=?, interrupted=1 WHERE finished_at IS NULL",
    [now()],
  );
  return n;
}

export async function runEngine(): Promise<void> {
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
  engineState.extractStats = null;
  engineState.stopRequested = false;
  engineState.forceStop = false;

  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  engineState.scanRoot = scanRoot;
  if (!scanRoot) {
    engineState.stage = "error";
    engineState.lastError = "scan_root not set";
    engineState.running = false;
    return;
  }
  // Validate tmp_dir up front so misconfiguration fails fast instead of
  // producing a half-extracted archive outside the expected tree.
  const tmpRawValue = (await getSetting("tmp_dir", TMP_DIR_DEFAULT)) ?? TMP_DIR_DEFAULT;
  const tmpRaw = tmpRawValue.trim();
  const tmpSpec = tmpRaw
    ? parseTmpDir(tmpRaw, scanRoot, (await getSetting("trash_subdir", "trash")) ?? "trash")
    : { kind: "relative" as const, value: TMP_DIR_DEFAULT };
  if (!tmpSpec) {
    engineState.stage = "error";
    engineState.lastError = `tmp_dir is invalid: ${tmpRawValue}`;
    engineState.running = false;
    return;
  }

  await setSetting("cancel", "0");

  let runRowId = 0;
  let logger: Logger | null = null;
  let errorLog: Logger | null = null;

  const fail = (msg: string, detail?: string) => {
    logger?.error(msg, detail);
    errorLog?.error(msg, detail);
  };
  const warn = (msg: string) => {
    logger?.warn(msg);
    errorLog?.warn(msg);
  };

  try {
    if ((await getSetting("resume", "1")) === "1") {
      const recovered = await recoverStale();
      if (recovered > 0) console.log(`resumed ${recovered} stale archive(s)`);
    }

    const startedAt = now();
    runRowId = await store.insertReturningId(
      "INSERT INTO runs(started_at, total) VALUES(?, 0)",
      [startedAt],
    );
    await setSetting("last_run_id", String(runRowId));

    logger = new Logger({ scope: "run", refId: runRowId, kind: "main" });
    errorLog = new Logger({ scope: "run", refId: runRowId, kind: "errors" });
    logger.info(`run ${runRowId} started`);

    engineState.runId = runRowId;
    engineState.startedAt = startedAt;
    engineState.stage = "listing";
    logger.info(`scan_root=${scanRoot}`);

    const rc = await Rclone.fromSettings(logger);
    rc.onCommand = (command) => {
      engineState.currentCommand = command;
    };

    // Absolute when tmp_dir is a remote/local path; inside root otherwise.
    const tmpRoot = tmpRootPath(scanRoot, tmpSpec);
    const tmpTop = tmpTopSegment(tmpSpec);
    const dryRunNow = (await getSetting("dry_run", "0")) === "1";
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
    }

    const queueMax = clampQueueMax(await getSetting("queue_max", "500"));
    const dryRun = (await getSetting("dry_run", "0")) === "1";
    const trashSubdir = (await getSetting("trash_subdir", "trash")) ?? "trash";
    const trashDir = normalizeRel(trashSubdir);
    const existing = new Map(
      (
        await store.query<{ path: string; status: string }>(
          "SELECT path, status FROM archives",
        )
      ).map((row) => [row.path, row.status]),
    );

    let queued = 0;
    const createdAt = now();
    const listed = await rc.list(async (rel, size) => {
      if ((await getSetting("cancel", "0")) === "1") return false;
      // Archives already sitting in the trash subdir are not queued again;
      // otherwise a done path there would be re-queued on every run.
      if (isTrashPath(rel, trashSubdir)) return;
      if (queued >= queueMax) return false;

      const prev = existing.get(rel);
      if (!prev) {
        await store.run(
          "INSERT OR IGNORE INTO archives(path, size, status, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?)",
          [rel, size, createdAt, createdAt],
        );
        existing.set(rel, "queued");
        queued++;
        return;
      }

      // A done path that is visible again is a new upload (the previous file
      // was moved to trash). Re-queue it. In dry-run the original is never
      // moved, so re-queueing would make every run redo the same work.
      if (prev === "done" && !dryRun) {
        await store.run(
          "UPDATE archives SET size=?, status='queued', error_kind=NULL, updated_at=? WHERE path=?",
          [size, now(), rel],
        );
        existing.set(rel, "queued");
        queued++;
      }
    });

    if (listed.streamError) {
      const cancelRequested =
        engineState.forceStop || (await getSetting("cancel", "0")) === "1";
      // A force-stopped listing is an intentional stop, not a failure.
      if (!cancelRequested) {
        const msg = "listing stream failed";
        fail(
          msg,
          `$ ${listed.command}\n${listed.streamError}\n${listed.stderr}`.trim(),
        );
        throw new Error(`${msg}: ${listed.streamError}`);
      }
      logger.info("listing stopped by user");
    } else if (listed.stopped) {
      logger.info("listing stopped early (queue limit or cancel)");
    } else if (listed.code !== 0) {
      const msg = `listing failed (exit ${listed.code})`;
      fail(msg, `$ ${listed.command}\n${listed.stderr}`.trim());
      throw new Error(msg);
    }
    if (listed.stderr.trim()) {
      warn(`listing stderr: ${listed.stderr.trim()}`);
    }
    logger.info(`listing complete: ${queued} new/requeued archive(s)`);

    engineState.stage = "queueing";
    const sortBy = (await getSetting("sort_by", "path")) === "size" ? "size" : "path";
    const sortDir = (await getSetting("sort_dir", "asc")) === "desc" ? "DESC" : "ASC";
    // Exclude pre-existing queued rows that live in the trash subdir (e.g.
    // enqueued by an older version), so they are never processed.
    const queueWhere = trashDir
      ? "WHERE status='queued' AND path <> ? AND path NOT LIKE ? ESCAPE '\\'"
      : "WHERE status='queued'";
    const queueParams: unknown[] = trashDir
      ? [trashDir, `${escapeLike(trashDir)}/%`]
      : [];
    const rows = await store.query<{ id: number; path: string; size: number }>(
      `SELECT id, path, size FROM archives ${queueWhere} ORDER BY ${sortBy} ${sortDir} LIMIT ?`,
      [...queueParams, queueMax],
    );

    await store.run("UPDATE runs SET total=? WHERE id=?", [rows.length, runRowId]);
    engineState.total = rows.length;
    logger.info(`queue size ${rows.length}`);

    engineState.stage = "extracting";

    for (const row of rows) {
      if ((await getSetting("cancel", "0")) === "1") {
        logger.info("cancel requested, stopping");
        engineState.stage = "cancelled";
        break;
      }

      const rel = row.path;
      engineState.currentRel = rel;
      engineState.extractStats = null;
      await store.run(
        "UPDATE archives SET status='extracting', updated_at=? WHERE id=?",
        [now(), row.id],
      );

      const baseName = rel.slice(rel.lastIndexOf("/") + 1);
      const tmp = tmpStemDir(tmpRoot, runRowId, row.id, stem(baseName));
      const archiveTmpDir = tmpArchiveDir(tmpRoot, runRowId, row.id);
      const ref = { scope: "archive" as const, refId: row.id, kind: "extract" as const };
      let result: "done" | "failed" | "skipped" = "failed";
      let tmpAttempted = false;

      await store.run(
        "INSERT OR REPLACE INTO logs(archive_id, kind, rel_path) VALUES(?, 'extract', ?)",
        [row.id, `archive-${row.id}-extract.log`],
      );

      try {
        // Inspect the archive before any extraction happens. Archives that
        // match the skip rules (empty, torrent, website, tiny) or cannot be
        // read are skipped and never extracted.
        const stats = createArchiveStats();
        const listOut = await rc.archiveList(rel, ref, (entry) =>
          addArchiveEntry(stats, entry.path, entry.size),
        );
        const listFailed = Boolean(listOut.streamError) || listOut.code !== 0;
        let skipReason: SkipReason | "unreadable" | "password" | null = null;
        if (listFailed) {
          skipReason = /password/i.test(listOut.stderr) ? "password" : "unreadable";
        } else {
          skipReason = classifyArchive(stats);
        }

        if (skipReason) {
          const detail = listFailed
            ? `listing failed (exit ${listOut.code})`
            : describeArchiveStats(stats);
          if (!listFailed) {
            await rc.note(ref, [`archive list: ${detail}`, `skip reason: ${skipReason}`]);
          }
          await store.run(
            "UPDATE archives SET status='skipped', error_kind=?, updated_at=? WHERE id=?",
            [skipReason, now(), row.id],
          );
          warn(`skipped (${skipReason}): ${rel} [${detail}]`);
          result = "skipped";
        } else {
        tmpAttempted = true;
        const ex = await rc.extract(rel, tmp, dryRun, ref, (stats) => {
          engineState.extractStats = stats;
        });
        engineState.extractStats = null;

        if (ex.code !== 0) {
          const all = `${ex.tail.join("\n")}\n${ex.stderr}`;
          if (/password/i.test(all)) {
            await store.run(
              "UPDATE archives SET status='skipped', error_kind='password', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            warn(`skipped (password): ${rel} [$ ${ex.command}]`);
            result = "skipped";
          } else {
            await rc.cleanup(tmp, dryRun, ref);
            await store.run(
              "UPDATE archives SET status='failed', error_kind='extract', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            fail(
              `extract failed: ${rel}`,
              `$ ${ex.command}\n${ex.tail.join("\n")}\n${ex.stderr}`.trim(),
            );
          }
        } else {
          const promoted = await rc.promote(rel, tmp, dryRun, ref, tmpTop);
          if (promoted.code !== 0) {
            await rc.cleanup(tmp, dryRun, ref);
            await store.run(
              "UPDATE archives SET status='failed', error_kind='promote', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            fail(
              `promote failed: ${rel}`,
              `$ ${promoted.command}\n${promoted.tail.join("\n")}\n${promoted.stderr}`.trim(),
            );
          } else {
            const cleaned = await rc.cleanup(tmp, dryRun, ref);
            if (cleaned.code !== 0) {
              warn(
                `cleanup failed: ${rel} [$ ${cleaned.command}] ${cleaned.stderr.trim()}`,
              );
            }

            const trashed = await rc.trash(rel, trashSubdir, dryRun, ref);
            if (trashed.code !== 0) {
              await store.run(
                "UPDATE archives SET status='failed', error_kind='trash', updated_at=? WHERE id=?",
                [now(), row.id],
              );
              fail(
                `trash failed: ${rel}`,
                `$ ${trashed.command}\n${trashed.tail.join("\n")}\n${trashed.stderr}`.trim(),
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
      } catch (e) {
        await store.run(
          "UPDATE archives SET status='failed', error_kind='spawn', updated_at=? WHERE id=?",
          [now(), row.id],
        );
        fail(`archive error: ${rel}`, String(e));
      } finally {
        if (engineState.forceStop) {
          // Hard stop while the archive was mid-flight: put it back in the
          // queue instead of counting it as done/failed/skipped, so it is
          // picked up again on the next run.
          await store.run(
            "UPDATE archives SET status='queued', updated_at=? WHERE id=?",
            [now(), row.id],
          );
          engineState.currentCommand = "";
          engineState.extractStats = null;
        } else {
          if (result === "done") engineState.done++;
          else if (result === "skipped") engineState.skipped++;
          else engineState.failed++;
          engineState.currentCommand = "";
          engineState.extractStats = null;
          await store.run("UPDATE runs SET done=?, failed=?, skipped=? WHERE id=?", [
            engineState.done,
            engineState.failed,
            engineState.skipped,
            runRowId,
          ]);
        }
        // Best effort: drop the now-empty per-archive temp dir. It stays
        // around (and failing rmdir is only a warning) when extraction did
        // not finish, so any partial data is kept.
        if (tmpAttempted) {
          const rmdir = await rc.rmdir(archiveTmpDir, dryRun, ref);
          if (rmdir.code !== 0) {
            warn(
              `rmdir failed: ${archiveTmpDir} [$ ${rmdir.command}] ${rmdir.stderr.trim() || "not empty"}`,
            );
          }
        }
      }
    }

    // Best effort: drop the now-empty run-level and global temp dirs. If a
    // directory is not empty (e.g. an archive was force-stopped mid-flight),
    // purge it instead of leaving junk behind.
    for (const p of [tmpRunDir(tmpRoot, runRowId), tmpRoot]) {
      const res = await rc.rmdir(p, dryRun);
      if (res.code !== 0) {
        const purged = await rc.purge(p, dryRun);
        if (purged.code === 0) {
          logger.info(`purged ${p} (not empty)`);
        } else {
          logger.info(`left ${p} in place (${purged.stderr.trim() || "not empty"})`);
        }
      }
    }

    // A stop requested while the last archive was being processed never gets
    // another loop iteration to notice it, so decide here.
    if (engineState.stage !== "cancelled") {
      engineState.stage = engineState.stopRequested ? "cancelled" : "finished";
    }
    engineState.finishedAt = now();
    await store.run("UPDATE runs SET finished_at=? WHERE id=?", [
      engineState.finishedAt,
      runRowId,
    ]);
    logger.info(
      `run ${runRowId} ${engineState.stage}: done=${engineState.done} failed=${engineState.failed} skipped=${engineState.skipped}`,
    );
  } catch (e) {
    engineState.lastError = String(e);
    engineState.stage = "error";
    engineState.finishedAt = now();
    fail("engine error", String(e));
    if (runRowId) {
      await store.run("UPDATE runs SET finished_at=? WHERE id=?", [
        engineState.finishedAt,
        runRowId,
      ]);
    }
  } finally {
    engineState.running = false;
    engineState.currentRel = "";
    engineState.currentCommand = "";
    engineState.extractStats = null;
    engineState.stopRequested = false;
    engineState.forceStop = false;
  }
}
