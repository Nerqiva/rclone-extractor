import { Logger } from "./log";
import { store, getSetting, setSetting } from "./db";
import { Rclone } from "./rclone";
import { tmpRel } from "./archive";

export const engineState = {
  running: false,
  runId: 0,
  stage: "idle", // idle|searching|listing|queueing|extracting|finished|error
  currentRel: "",
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  lastError: "",
};

export function stopEngine(): void {
  void setSetting("cancel", "1");
}

function now(): string {
  return new Date().toISOString();
}

/** Reset archives left mid-extraction by a crash back to the queue. */
export async function recoverStale(): Promise<number> {
  const before = await store.query<{ c: number }>(
    "SELECT COUNT(*) AS c FROM archives WHERE status='extracting'",
  );
  const n = Number(before[0]?.c ?? 0);
  if (n > 0) {
    await store.run("UPDATE archives SET status='queued' WHERE status='extracting'");
  }
  return n;
}

export async function runEngine(): Promise<void> {
  if (engineState.running) return;
  engineState.running = true;
  engineState.lastError = "";
  engineState.runId = 0;
  engineState.currentRel = "";
  engineState.total = 0;
  engineState.done = 0;
  engineState.failed = 0;
  engineState.skipped = 0;

  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  if (!scanRoot) {
    engineState.stage = "error";
    engineState.lastError = "scan_root not set";
    engineState.running = false;
    return;
  }

  await setSetting("cancel", "0");

  let runRowId = 0;
  let logger: Logger | null = null;

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
    logger.info(`run ${runRowId} started`);

    engineState.runId = runRowId;
    engineState.stage = "searching";
    logger.info(`scan_root=${scanRoot}`);
    engineState.stage = "listing";

    const rc = await Rclone.fromSettings();
    const queueMax = Number((await getSetting("queue_max", "500")) ?? "500");
    let queued = 0;
    const createdAt = now();
    await rc.list(async (rel, size) => {
      if (queued >= queueMax) return;
      await store.run(
        "INSERT OR IGNORE INTO archives(path, size, status, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?)",
        [rel, size, createdAt, createdAt],
      );
      queued++;
    });
    logger.info(`listing complete: ${queued} archives queued`);

    engineState.stage = "queueing";
    const sortBy = (await getSetting("sort_by", "path")) === "size" ? "size" : "path";
    const sortDir = (await getSetting("sort_dir", "asc")) === "desc" ? "DESC" : "ASC";
    const rows = await store.query<{ id: number; path: string; size: number }>(
      `SELECT id, path, size FROM archives WHERE status='queued' ORDER BY ${sortBy} ${sortDir}`,
    );

    await store.run("UPDATE runs SET total=? WHERE id=?", [rows.length, runRowId]);
    engineState.total = rows.length;
    logger.info(`queue size ${rows.length}`);

    engineState.stage = "extracting";
    const dryRun = (await getSetting("dry_run", "0")) === "1";
    const trashSubdir = (await getSetting("trash_subdir", "trash")) ?? "trash";

    for (const row of rows) {
      if ((await getSetting("cancel", "0")) === "1") {
        logger.info("cancel requested, stopping");
        break;
      }

      const rel = row.path;
      engineState.currentRel = rel;
      await store.run(
        "UPDATE archives SET status='extracting', updated_at=? WHERE id=?",
        [now(), row.id],
      );

      const tmp = tmpRel(rel, runRowId);
      const ref = { scope: "archive" as const, refId: row.id, kind: "extract" as const };

      const ex = await rc.extract(rel, tmp, dryRun, ref);
      await store.run(
        "INSERT OR REPLACE INTO logs(archive_id, kind, rel_path) VALUES(?, 'extract', ?)",
        [row.id, `archive-${row.id}-extract.log`],
      );

      if (ex.code !== 0) {
        const all = `${ex.tail.join("\n")}\n${ex.stderr}`;
        if (/password/i.test(all)) {
          await store.run(
            "UPDATE archives SET status='skipped', error_kind='password', updated_at=? WHERE id=?",
            [now(), row.id],
          );
          logger.warn(`skipped (password): ${rel}`);
          engineState.skipped++;
        } else {
          await rc.cleanup(tmp, dryRun, ref);
          await store.run(
            "UPDATE archives SET status='failed', error_kind='extract', updated_at=? WHERE id=?",
            [now(), row.id],
          );
          logger.error(`extract failed: ${rel}`, ex.tail.join("\n"));
          engineState.failed++;
        }
      } else {
        await rc.promote(rel, tmp, dryRun, ref);
        await rc.cleanup(tmp, dryRun, ref);
        await rc.trash(rel, trashSubdir, dryRun, ref);
        await store.run(
          "UPDATE archives SET status='done', error_kind=NULL, updated_at=? WHERE id=?",
          [now(), row.id],
        );
        logger.info(`done: ${rel}`);
        engineState.done++;
      }

      await store.run("UPDATE runs SET done=?, failed=?, skipped=? WHERE id=?", [
        engineState.done,
        engineState.failed,
        engineState.skipped,
        runRowId,
      ]);
    }

    engineState.stage = "finished";
    await store.run("UPDATE runs SET finished_at=? WHERE id=?", [now(), runRowId]);
    logger.info(
      `run ${runRowId} finished: done=${engineState.done} failed=${engineState.failed} skipped=${engineState.skipped}`,
    );
  } catch (e) {
    engineState.lastError = String(e);
    engineState.stage = "error";
    logger?.error("engine error", String(e));
    if (runRowId) {
      await store.run("UPDATE runs SET finished_at=? WHERE id=?", [now(), runRowId]);
    }
  } finally {
    engineState.running = false;
    engineState.currentRel = "";
  }
}
