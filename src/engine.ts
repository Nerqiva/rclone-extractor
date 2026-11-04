import { Logger, logPath } from "./log";
import { db, getSetting, setSetting } from "./db";
import { Rclone } from "./rclone";
import { parentRel, tmpRel, trashRel } from "./archive";

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
  setSetting("cancel", "1");
}

function now(): string {
  return new Date().toISOString();
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

  const scanRoot = getSetting("scan_root", "") ?? "";
  if (!scanRoot) {
    engineState.stage = "error";
    engineState.lastError = "scan_root not set";
    engineState.running = false;
    return;
  }

  setSetting("cancel", "0");

  let runRowId = 0;
  let logger: Logger | null = null;

  try {
    const startedAt = now();
    const ins = db
      .query("INSERT INTO runs(started_at, total) VALUES(?, 0)")
      .run(startedAt);
    runRowId = Number(ins.lastInsertRowid);

    const stamp = startedAt.replace(/[:.]/g, "-");
    const runName = `run-${runRowId}-${stamp}.log`;
    logger = new Logger(logPath(runName));
    logger.info(`run ${runRowId} started`);

    engineState.runId = runRowId;
    engineState.stage = "searching";
    logger.info(`scan_root=${scanRoot}`);
    engineState.stage = "listing";

    const rc = Rclone.fromSettings();
    const queueMax = Number(getSetting("queue_max", "500") ?? "500");
    let queued = 0;
    const createdAt = now();
    const insertArchive = db.query(
      "INSERT OR IGNORE INTO archives(path, size, status, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?)",
    );
    await rc.list((rel, size) => {
      if (queued >= queueMax) return;
      insertArchive.run(rel, size, createdAt, createdAt);
      queued++;
    });
    logger.info(`listing complete: ${queued} archives queued`);

    engineState.stage = "queueing";
    const sortBy = getSetting("sort_by", "path") === "size" ? "size" : "path";
    const sortDir = getSetting("sort_dir", "asc") === "desc" ? "DESC" : "ASC";
    const rows = db
      .query(
        `SELECT id, path, size FROM archives WHERE status='queued' ORDER BY ${sortBy} ${sortDir}`,
      )
      .all() as { id: number; path: string; size: number }[];

    db.query("UPDATE runs SET total=? WHERE id=?").run(rows.length, runRowId);
    engineState.total = rows.length;
    logger.info(`queue size ${rows.length}`);

    engineState.stage = "extracting";
    const dryRun = (getSetting("dry_run", "0") ?? "0") === "1";
    const trashSubdir = getSetting("trash_subdir", "trash") ?? "trash";

    for (const row of rows) {
      if ((getSetting("cancel", "0") ?? "0") === "1") {
        logger.info("cancel requested, stopping");
        break;
      }

      const rel = row.path;
      engineState.currentRel = rel;
      db.query("UPDATE archives SET status='extracting', updated_at=? WHERE id=?").run(
        now(),
        row.id,
      );

      const tmp = tmpRel(rel, runRowId);
      const extractLog = logPath(`archive-${row.id}-extract.log`);

      const ex = await rc.extract(rel, tmp, dryRun, extractLog);
      db.query(
        "INSERT OR REPLACE INTO logs(archive_id, kind, rel_path) VALUES(?, 'extract', ?)",
      ).run(row.id, extractLog);

      if (ex.code !== 0) {
        const all = `${ex.tail.join("\n")}\n${ex.stderr}`;
        if (/password/i.test(all)) {
          db.query(
            "UPDATE archives SET status='skipped', error_kind='password', updated_at=? WHERE id=?",
          ).run(now(), row.id);
          logger.warn(`skipped (password): ${rel}`);
          engineState.skipped++;
        } else {
          await rc.cleanup(tmp, dryRun, extractLog);
          db.query(
            "UPDATE archives SET status='failed', error_kind='extract', updated_at=? WHERE id=?",
          ).run(now(), row.id);
          logger.error(`extract failed: ${rel}`, ex.tail.join("\n"));
          engineState.failed++;
        }
      } else {
        await rc.promote(rel, tmp, dryRun, extractLog);
        await rc.cleanup(tmp, dryRun, extractLog);
        await rc.trash(rel, trashSubdir, dryRun, extractLog);
        db.query(
          "UPDATE archives SET status='done', error_kind=NULL, updated_at=? WHERE id=?",
        ).run(now(), row.id);
        logger.info(`done: ${rel}`);
        engineState.done++;
      }

      db.query(
        "UPDATE runs SET done=?, failed=?, skipped=? WHERE id=?",
      ).run(engineState.done, engineState.failed, engineState.skipped, runRowId);
    }

    engineState.stage = "finished";
    db.query("UPDATE runs SET finished_at=? WHERE id=?").run(now(), runRowId);
    logger.info(
      `run ${runRowId} finished: done=${engineState.done} failed=${engineState.failed} skipped=${engineState.skipped}`,
    );
  } catch (e) {
    engineState.lastError = String(e);
    engineState.stage = "error";
    logger?.error("engine error", String(e));
    if (runRowId) db.query("UPDATE runs SET finished_at=? WHERE id=?").run(now(), runRowId);
  } finally {
    engineState.running = false;
    engineState.currentRel = "";
  }
}
