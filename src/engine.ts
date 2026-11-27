import { createHash } from "node:crypto";
import { baseNameOf, dirOfRel } from "./domain";
import { liveRunIds, STALE_MS } from "./runs";
import { Logger, insertLogLines } from "./log";
import { store, getSetting, setSetting, allSettings } from "./db";
import { Rclone, killActiveProcs, writeRunConfSnapshot, deleteRunConfSnapshot, type ExtractStats, type Outcome } from "./rclone";
import { validateStoredExtraFlags } from "./extraflags";
import {
  tmpRootPath,
  tmpRunDir,
  tmpArchiveDir,
  tmpStemDir,
  tmpTopSegment,
} from "./tmpdir";
import { loadTmpDirSettings } from "./tmpsweep";
import { isArchiveDownloading } from "./downloads";
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
  isRclonexFormat,
  archiveFamily,
  namesRelated,
  TRASH,
  type SkipReason,
} from "./archive";

// Per-run state for the "first archive per (directory, archive family) gets
// pre-inspection; the rest of a similar series are extracted first" rule.
// `ref` is the first archive's base name in the group (set once its
// inspection produced a verdict); `open` is true when it passed. Created
// fresh each run — never persisted.
type GroupState = { ref: string | null; open: boolean };

export type JobStatus = "queued" | "active" | "done" | "failed" | "skipped";

/** Live state for one archive in the current run. Never persisted. */
export interface JobState {
  id: number;
  rel: string;
  order: number;
  status: JobStatus;
  phase: string;
  command: string;
  stats: ExtractStats | null;
  skipArchive: boolean;
  skipInspection: boolean;
  groupKey: string | null;
  finishedAt: string;
}

/**
 * Record the first archive's inspection verdict for its (directory, family)
 * group. Only the first archive to reach a verdict sets the anchor; later
 * archives of the group never move it.
 */
function noteGroupInspection(
  group: GroupState | undefined,
  baseName: string,
  passed: boolean,
): void {
  if (!group || group.ref !== null) return;
  group.ref = baseName;
  group.open = passed;
}

/** A password-archive move accepted while a run is active. */
export type PasswordMoveDirection = "delete" | "restore";
export type DeferredPasswordMove = { id: number; direction: PasswordMoveDirection };

export type PasswordMoveResult =
  | { kind: "moved"; direction: PasswordMoveDirection }
  | { kind: "dropped" }
  | { kind: "rejected"; message: string; level: "ok" | "err" };

export const engineState = {
  running: false,
  runId: 0,
  stage: "idle", // idle|listing|queueing|extracting|finished|error
  currentCommand: "",
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  startedAt: "",
  finishedAt: "",
  lastError: "",
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
  // The scan_root this run started with. Shown on the Progress page while
  // the run is active (the stored setting may change mid-run and applies
  // only from the next run).
  currentScanRoot: "",
  // Temporary, per-run skip flags (never persisted to the database). Each is
  // consumed by the archive/stage in flight and does not carry over to the
  // next archive, stage, or run.
  skipListing: false,
  // True while an archive is being processed (set where last_archive is
  // persisted, cleared in the per-archive finally). Lets skip requests tell
  // "between archives" apart from "an archive is in flight".
  archiveInFlight: false,
  // Password-archive Delete/Restore accepted while a run is active. Applied
  // at the next per-archive boundary, discarded on hard stop or app error.
  // Per-run and in-memory only — never persisted.
  deferredPasswordMoves: [] as DeferredPasswordMove[],
  // One entry per queued archive, in queue order. The single source of truth
  // for live per-job progress; the scalar fields above mirror the primary
  // active job for the controls and the stop path.
  jobs: new Map<number, JobState>(),
  activeIds: new Set<number>(),
  concurrency: 1,
};

/**
 * Validate and perform one password-archive move. Shared by the route and the
 * in-run drain: every check runs at call time, so a deferred move sees current
 * state. No app wording goes to the archive's raw log; callers own the toast
 * and the run-level diagnostic.
 */
export async function performPasswordMove(
  direction: PasswordMoveDirection,
  id: number,
): Promise<PasswordMoveResult> {
  const del = direction === "delete";
  if (!Number.isInteger(id) || id <= 0) {
    return { kind: "rejected", message: "Not found.", level: "err" };
  }
  const row = await store.get1<{ path: string; status: string; error_kind: string | null }>(
    "SELECT path, status, error_kind FROM archives WHERE id = ?",
    [id],
  );
  if (!row || row.error_kind !== "password") {
    return { kind: "rejected", message: "Not a password-protected archive.", level: "err" };
  }
  if (del ? row.status === "deleted" : row.status !== "deleted") {
    return {
      kind: "rejected",
      message: del ? "Already in trash." : "Archive is not in trash.",
      level: "ok",
    };
  }
  const rel = String(row.path);
  if (!isSafeRel(rel)) {
    return {
      kind: "rejected",
      message: "Stored path is unsafe; refusing to move it.",
      level: "err",
    };
  }
  if (isArchiveDownloading(id)) {
    return {
      kind: "rejected",
      message: "A download of this archive is in progress; wait for it to finish.",
      level: "err",
    };
  }
  const trash = parseTrashSubdir((await getSetting("trash_subdir", TRASH)) ?? TRASH);
  if (!trash) {
    return { kind: "rejected", message: "trash_subdir is invalid.", level: "err" };
  }
  const ref = { scope: "archive" as const, refId: id, kind: "extract" as const };
  const rc = await Rclone.fromSettings();
  const trashRel = normalizeRel(`${trash}/${rel}`);
  const srcRel = del ? rel : trashRel;
  const destRel = del ? trashRel : rel;
  if (!del && !(await rc.existsPath(srcRel))) {
    // The trash copy is gone; the row can never be restored. Drop it instead
    // of leaving a Restore button that can only fail.
    await store.run("DELETE FROM log_lines WHERE scope='archive' AND ref_id = ?", [id]);
    await store.run("DELETE FROM archives WHERE id = ?", [id]);
    return { kind: "dropped" };
  }
  if (await rc.existsPath(destRel)) {
    return {
      kind: "rejected",
      message: del
        ? `The trash already contains ${destRel} — remove it before deleting.`
        : `A file now exists at ${destRel} — remove it before restoring.`,
      level: "err",
    };
  }
  const res = await rc.moveToRel(srcRel, destRel, ref);
  if (res.code !== 0) {
    const detail =
      (res.tail || []).slice(-1)[0] ?? res.stderr.trim().split("\n").pop() ?? "unknown error";
    return {
      kind: "rejected",
      message: `${del ? "Move to trash" : "Restore"} failed (exit ${res.code}): ${detail}`,
      level: "err",
    };
  }
  if (del) {
    await store.run("UPDATE archives SET status='deleted', updated_at=? WHERE id=?", [
      new Date().toISOString(),
      id,
    ]);
  } else {
    await store.run(
      "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE id=?",
      [new Date().toISOString(), id],
    );
  }
  return { kind: "moved", direction };
}

/** Queue a move while a run is active. At most one pending move per archive. */
export function queuePasswordMove(direction: PasswordMoveDirection, id: number): boolean {
  if (engineState.deferredPasswordMoves.some((m) => m.id === id)) return false;
  engineState.deferredPasswordMoves.push({ id, direction });
  return true;
}

/** Drop every pending move and leave a short note in the run log. */
function discardDeferredPasswordMoves(reason: string): number {
  const n = engineState.deferredPasswordMoves.length;
  if (n === 0) return 0;
  engineState.deferredPasswordMoves = [];
  void insertLogLines(
    { scope: "run", refId: engineState.runId, kind: "main" },
    [`discarded ${n} queued password move(s) (${reason})`],
  ).catch(() => {});
  return n;
}

/** Apply all pending password moves. Safe to call at every archive boundary. */
export async function drainDeferredPasswordMoves(): Promise<void> {
  if (engineState.forceStop) return; // a hard stop discards the queue instead
  const pending = engineState.deferredPasswordMoves;
  if (pending.length === 0) return;
  engineState.deferredPasswordMoves = [];
  for (const item of pending) {
    try {
      const result = await performPasswordMove(item.direction, item.id);
      if (result.kind === "rejected") {
        await insertLogLines(
          { scope: "run", refId: engineState.runId, kind: "errors" },
          [`queued password move id=${item.id} (${item.direction}) rejected: ${result.message}`],
        ).catch(() => {});
      }
    } catch (e) {
      await insertLogLines(
        { scope: "run", refId: engineState.runId, kind: "errors" },
        [`queued password move id=${item.id} (${item.direction}) failed: ${String(e)}`],
      ).catch(() => {});
    }
  }
}

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
  discardDeferredPasswordMoves("hard stop");
  killActiveProcs();
}

/**
 * Stage/archive skips. Temporary and in-memory only — never persisted to the
 * database — and consumed by the target archive at most once. Each request
 * kills only that job's binary (listing is serial and uses the global kill).
 * An omitted id targets the first active job, which keeps the original
 * single-archive API and its callers working unchanged.
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

function activeJobForSkip(id?: number): JobState | undefined {
  if (id !== undefined) {
    const job = engineState.jobs.get(id);
    return job?.status === "active" ? job : undefined;
  }
  for (const job of engineState.jobs.values()) {
    if (job.status === "active") return job;
  }
  return undefined;
}

export function requestSkipInspection(id?: number): boolean {
  if (!engineState.running || engineState.stage !== "extracting") return false;
  const job = activeJobForSkip(id);
  if (!job || job.phase !== "Inspecting archive") return false;
  job.skipInspection = true;
  killActiveProcs(job.id);
  return true;
}

export function requestSkipArchive(id?: number): boolean {
  if (!engineState.running || engineState.stage !== "extracting") return false;
  const job = activeJobForSkip(id);
  if (!job) return false;
  job.skipArchive = true;
  killActiveProcs(job.id);
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

function throwIfSkipArchive(job: JobState): void {
  if (job.skipArchive || engineState.forceStop) {
    throw new ArchiveSkipRequested();
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Mirror the active job's phase and command into the scalar controls view. */
function refreshPrimaryMirror(): void {
  const job = activeJobForSkip();
  engineState.currentCommand = job?.command ?? "";
  engineState.activity = job?.phase ?? "";
  engineState.archiveInFlight = engineState.activeIds.size > 0;
}

/** Set a job's phase; the scalar fields mirror it only when it is primary. */
function setActivity(label: string, job?: JobState | null): void {
  if (job) {
    job.phase = label;
    job.stats = null;
  }
  const primary = activeJobForSkip();
  if (!job || !primary || primary === job) {
    engineState.activity = label;
  }
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

/** Upper bound on simultaneous extraction workers; shared by form and engine. */
export const MAX_CONCURRENCY = 8;

/** Strict parse for the config form: null means "reject, do not silently clamp". */
export function parseConcurrency(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CONCURRENCY) return null;
  return n;
}

/** Retry cooldown in whole seconds (0..86400), or null when invalid. */
export function parseCooldownSeconds(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > 86400) return null;
  return n;
}

export type RetryPolicy = { baseMs: number; maxRetries: 3 };

/** Cooldowns for retries 1, 2 and 3: base, twice base, four times base. */
export function retryDelays(baseMs: number): readonly [number, number, number] {
  return [baseMs, baseMs * 2, baseMs * 4];
}

type RetryOptions<T> = {
  label: string;
  log: (line: string) => void;
  retryable?: (outcome: T) => boolean;
  beforeRetry?: () => Promise<void>;
};

/** Sleep in short slices so a skip or hard stop aborts the wait promptly. */
async function waitCooldown(job: JobState, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (true) {
    // The job flag (and a hard stop) aborts the wait; a soft stop does not.
    throwIfSkipArchive(job);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
}

/**
 * Run one command up to maxRetries+1 times. Successes, skips and explicitly
 * non-retryable failures return on the first try; only failed outcomes and
 * thrown spawn errors wait and re-invoke the same command.
 */
async function withRetries<T extends Outcome>(
  job: JobState,
  policy: RetryPolicy,
  invoke: () => Promise<T>,
  opts: RetryOptions<T>,
): Promise<T> {
  const delays = retryDelays(policy.baseMs);
  for (let attempt = 0; ; attempt++) {
    let outcome: T;
    try {
      outcome = await invoke();
    } catch (e) {
      if (e instanceof ArchiveSkipRequested || attempt >= policy.maxRetries) throw e;
      const ms = delays[attempt];
      opts.log(`retry ${attempt + 1}/${policy.maxRetries} after ${ms / 1000}s: ${opts.label}`);
      await waitCooldown(job, ms);
      await opts.beforeRetry?.();
      throwIfSkipArchive(job);
      continue;
    }
    if (outcome.code === 0 || (opts.retryable && !opts.retryable(outcome))) {
      return outcome;
    }
    if (attempt >= policy.maxRetries) return outcome;
    const ms = delays[attempt];
    opts.log(`retry ${attempt + 1}/${policy.maxRetries} after ${ms / 1000}s: ${opts.label}`);
    await waitCooldown(job, ms);
    await opts.beforeRetry?.();
    throwIfSkipArchive(job);
  }
}

function clampConcurrency(raw: string | undefined): number {
  return parseConcurrency(raw ?? "1") ?? 1;
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

// Run heartbeat. recoverStale only reclaims runs whose heartbeat is older
// than its staleness threshold, so a second instance never closes a live
// peer's run. Throttled: one write per 30 s is plenty.
const TOUCH_THROTTLE_MS = 30_000;
let lastTouchAt = 0;

async function touchRun(runId: number): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastTouchAt < TOUCH_THROTTLE_MS) return;
  lastTouchAt = nowMs;
  try {
    await store.run("UPDATE runs SET last_touch_at = ? WHERE id = ?", [
      new Date(nowMs).toISOString(),
      runId,
    ]);
  } catch {
    // heartbeat is auxiliary; never fail an archive over it
  }
}

/** Per-job onStats closure: updates that job's bar and the run heartbeat. */
function statsTracker(runId: number, job: JobState) {
  return (stats: ExtractStats) => {
    job.stats = stats;
    void touchRun(runId);
  };
}

/** Tag an archive as processed by this run (Logs page Archives tab). */
async function markRunTouch(archiveId: number, runId: number): Promise<void> {
  try {
    await store.run("UPDATE archives SET last_run_id = ? WHERE id = ?", [runId, archiveId]);
  } catch {
    // tagging is auxiliary; never fail the archive over it
  }
  await touchRun(runId);
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
 * Archives whose trash copy exists were fully processed — the crash happened
 * between trash() and the done-UPDATE. Finalize them as done instead of
 * re-queueing into a permanent extract failure. Only ever called with the
 * ids of archives this recovery owns (see recoverStale).
 */
async function settleTrashMovedArchives(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const ph = ids.map(() => "?").join(", ");
  const rows = await store.query<{ id: number | string; path: string }>(
    `SELECT id, path FROM archives WHERE status='extracting' AND id IN (${ph})`,
    ids,
  );
  if (rows.length === 0) return 0;
  let rc: Rclone | null = null;
  const trash = parseTrashSubdir((await getSetting("trash_subdir", TRASH)) ?? TRASH);
  if (trash) {
    try {
      rc = await Rclone.fromSettings();
    } catch {
      rc = null; // remote unreachable — fall back to plain re-queue
    }
  }
  if (!rc) return 0;
  let settled = 0;
  for (const row of rows) {
    const rel = String(row.path);
    if (!isSafeRel(rel)) continue;
    let hit = false;
    try {
      hit = await rc.existsPath(`${trash}/${rel}`);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    await store.run(
      "UPDATE archives SET status='done', error_kind=NULL, updated_at=? WHERE id=?",
      [now(), row.id],
    );
    await insertLogLines(
      { scope: "archive", refId: Number(row.id), kind: "extract" },
      ["recovered: archive was already moved to trash; finalized as done"],
    ).catch(() => {});
    settled++;
  }
  return settled;
}

// One delayed re-check at most: a crash seconds before a replica boots must
// still be reclaimed once it goes quiet for STALE_MS, instead of sitting in
// 'extracting' forever (boot/start recovery only runs at those moments).
let recheckPending = false;

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
  settleTrash = false,
): Promise<number> {
  const cutoffIso = new Date(Date.now() - STALE_MS).toISOString();
  const unfinished = await store.query<{
    id: number | string;
    started_at: string | null;
    last_touch_at: string | null;
  }>(
    "SELECT id, started_at, last_touch_at FROM runs WHERE finished_at IS NULL AND id != ?",
    [excludeRunId],
  );
  const staleRunIds: number[] = [];
  let freshPeer = false;
  for (const r of unfinished) {
    // Legacy rows predate the heartbeat; their start time is the best signal.
    const base = r.last_touch_at ?? r.started_at ?? "";
    if (base < cutoffIso) staleRunIds.push(Number(r.id));
    else freshPeer = true;
  }
  const extracting = await store.query<{ id: number | string; last_run_id: number | null }>(
    "SELECT id, last_run_id FROM archives WHERE status='extracting'",
  );
  const staleSet = new Set(staleRunIds);
  const owned = extracting.filter((a) => {
    const rid = Number(a.last_run_id ?? 0);
    if (rid) return staleSet.has(rid);
    // Untagged rows: no owner signal — reclaim only when nothing is live.
    return !freshPeer;
  });
  const n = owned.length;
  if (owned.length > 0) {
    const ownedIds = owned.map((a) => Number(a.id));
    const ph = ownedIds.map(() => "?").join(", ");
    if (recoverArchives) {
      if (settleTrash) {
        const settled = await settleTrashMovedArchives(ownedIds);
        if (settled > 0) {
          console.log(`recoverStale: finalized ${settled} archive(s) already in trash as done`);
        }
      }
      await store.run(
        `UPDATE archives SET status='queued', updated_at=? WHERE status='extracting' AND id IN (${ph})`,
        [now(), ...ownedIds],
      );
    } else {
      // No binary output exists for these; store a webapp diagnostic per
      // archive so the error row's Copy/Download is not an empty 404.
      await store.run(
        `UPDATE archives SET status='failed', error_kind='killed', updated_at=? WHERE status='extracting' AND id IN (${ph})`,
        [now(), ...ownedIds],
      );
      for (const a of owned) {
        await insertLogLines(
          { scope: "archive", refId: Number(a.id), kind: "extract" },
          ["killed: app stopped before extraction finished"],
        ).catch(() => {});
      }
    }
  }
  if (freshPeer && !recheckPending) {
    recheckPending = true;
    const t = setTimeout(() => {
      recheckPending = false;
      void recoverStale(recoverArchives, reason, excludeRunId, settleTrash).catch(() => {});
    }, STALE_MS);
    t.unref?.();
  }
  if (staleRunIds.length > 0) {
    const ph = staleRunIds.map(() => "?").join(", ");
    await store.run(
      `UPDATE runs SET finished_at=?, outcome='killed', interrupted=1, interrupted_reason=?, error_kind='killed' WHERE finished_at IS NULL AND id IN (${ph})`,
      [now(), reason, ...staleRunIds],
    );
    for (const id of staleRunIds) {
      await insertLogLines(
        { scope: "run", refId: id, kind: "main" },
        [`[killed] ${reason}`],
      ).catch(() => {});
      await insertLogLines(
        { scope: "run", refId: id, kind: "errors" },
        [`[killed] ${reason}`],
      ).catch(() => {});
    }
  }
  return n;
}

const INTERNAL_SETTINGS = new Set([
  "scan_cache_key",
  "scan_cache_state",
  "last_run_id",
  "cancel",
]);

export function configFingerprint(settings: Record<string, string>): string {
  const pairs = Object.keys(settings)
    .filter((key) => !INTERNAL_SETTINGS.has(key))
    .sort()
    .map((key) => `${key}=${settings[key]}`);
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

export async function runEngine(): Promise<void> {
  if (engineState.running) return;
  engineState.running = true;
  engineState.lastError = "";
  engineState.runId = 0;
  engineState.currentCommand = "";
  engineState.total = 0;
  engineState.done = 0;
  engineState.failed = 0;
  engineState.skipped = 0;
  engineState.startedAt = "";
  engineState.finishedAt = "";
  engineState.activity = "";
  engineState.stopRequested = false;
  engineState.forceStop = false;
  engineState.errorKind = "";
  engineState.interruptReason = "";
  engineState.skipListing = false;
  engineState.archiveInFlight = false;
  engineState.deferredPasswordMoves = [];
  engineState.currentScanRoot = "";
  engineState.jobs = new Map();
  engineState.activeIds = new Set();
  engineState.concurrency = 1;

  // One settings read at run start. Everything the engine consumes is pinned
  // to this snapshot; a config edit during the run applies from the next run.
  const cfg = await allSettings();
  const scanRoot = cfg["scan_root"] ?? "";
  engineState.currentScanRoot = scanRoot;
  // Validate tmp_dir up front so misconfiguration fails fast instead of
  // producing a half-extracted archive outside the expected tree.
  const trashRaw = cfg["trash_subdir"] ?? TRASH;
  const trashSubdirValidated = parseTrashSubdir(trashRaw);
  const tmpSettings = trashSubdirValidated
    ? await loadTmpDirSettings(trashSubdirValidated, cfg)
    : null;
  const tmpSpec = tmpSettings?.spec ?? null;

  let runRowId = 0;
  let logger: Logger | null = null;
  let errorLog: Logger | null = null;
  let errorKind = "engine_error";
  // Per-run private rclone.conf snapshot, created once the run is underway
  // (its content is resolved from the stored/env conf at that moment) and
  // deleted in the finally block. Null when nothing is configured or the
  // write fails — the run then uses the shared working copy, as before.
  let runConf: string | null = null;

  const fail = (msg: string, detail?: string) => {
    const command = engineState.currentCommand;
    const body = detail && command && !detail.includes(command)
      ? `$ ${command}\n${detail}`
      : detail ?? (command ? `$ ${command}` : undefined);
    logger?.error(msg, body);
    errorLog?.error(msg, body);
  };
  const warn = (msg: string) => {
    logger?.warn(msg);
    errorLog?.warn(msg);
  };

  // App errors — before or after the run row exists — close the run with
  // outcome='error' and a short error code, and leave log lines behind, so
  // they never masquerade as a finish or a host kill.
  const abortWithError = async (code: string, msg: string) => {
    discardDeferredPasswordMoves(code);
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
  await touchRun(runRowId);

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
  // Backstop for flags that bypassed the config form (old backup, DB edit):
  // fail once with the setting name instead of failing every archive.
  const flagProblems = await validateStoredExtraFlags(await allSettings());
  if (flagProblems.length) {
    await abortWithError("invalid_extra_flags", flagProblems.join("; "));
    return;
  }

  await setSetting("cancel", "0");
  resetCancelCache();

  try {
    const resumeEnabled = (cfg["resume"] ?? "1") === "1";
    const recovered = await recoverStale(resumeEnabled, undefined, runRowId, true);
    if (recovered > 0) {
      console.log(
        resumeEnabled
          ? `resumed ${recovered} stale archive(s)`
          : `marked ${recovered} killed archive(s) as failed`,
      );
    }

    engineState.stage = "listing";
    logger.info(`scan_root=${scanRoot}`);

    // Isolated rclone.conf for this run: a per-run private snapshot, so
    // config edits made while this run is active (which sync the shared
    // working copy for on-demand calls) cannot leak into it. Deleted in the
    // finally block when the run ends.
    runConf = await writeRunConfSnapshot(runRowId);
    if (runConf) {
      logger.info(`rclone.conf snapshot: this run is pinned to a private copy`);
    } else {
      logger.info(`rclone.conf snapshot: none (no stored/env conf) — using the shared working copy`);
    }
    const rc = await Rclone.fromSettings(logger, runConf ? { confPath: runConf } : {});
    // Persist every command dispatch so a crash/kill leaves the in-flight
    // command behind for the Progress page. Fire-and-forget: a command must
    // never wait on (or fail because of) this bookkeeping write.
    const persistCommand = (command: string, job?: JobState) => {
      if (job) job.command = command;
      if (!job || activeJobForSkip() === job) engineState.currentCommand = command;
      void store
        .run("UPDATE runs SET last_command=? WHERE id=?", [command, runRowId])
        .catch(() => {});
    };
    rc.onCommand = persistCommand;

    // Absolute when tmp_dir is a remote/local path; inside root otherwise.
    const tmpRoot = tmpRootPath(scanRoot, tmpSpec);
    const tmpTop = tmpTopSegment(tmpSpec);
    // tmpSettings is non-null here: an invalid tmp_dir already aborted above.
    setActivity("Purging stale temp");
    try {
      const res = await rc.purgeStaleTemp(tmpRoot, await liveRunIds());
      if (res.purged.length) {
        const verb = "purged";
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

    const queueMax = clampQueueMax(cfg["queue_max"] ?? "500");
    const maxArchiveSize = clampArchiveSize(cfg["max_archive_size"] ?? "0");
    const minArchiveSize = clampArchiveSize(cfg["min_archive_size"] ?? "0");
    const cooldownSeconds =
      parseCooldownSeconds(cfg["retry_cooldown_seconds"] ?? "60") ?? 60;
    const policy: RetryPolicy = { baseMs: cooldownSeconds * 1000, maxRetries: 3 };
    logger.info(`retry cooldown=${cooldownSeconds}s (up to ${policy.maxRetries} retries)`);
    const rclonexEnabled = (cfg["rclonex"] ?? "0") === "1";
    // RcloneX-specific extraction flags (default off). A stored archive
    // password is only passed when its checkbox enabled it.
    const rclonexPasswordEnabled =
      (cfg["rclonex_archive_password_enabled"] ?? "0") === "1";
    const rclonexPassword = cfg["rclonex_archive_password"] ?? "";
    // Sliding-window buffer for random-access formats read by rclonex
    // (7Z, ISO) — stored as bytes; 0 disables the override (rclonex keeps
    // its own default).
    const rawBuffer = cfg["rclonex_archive_buffer_size"] ?? "16777216";
    const rclonexBufferSize = Number(rawBuffer);
    const rclonexFlags: string[] = [];
    if (rclonexPasswordEnabled && rclonexPassword) {
      rclonexFlags.push("--archive-password", rclonexPassword);
    }
    if (!Number.isFinite(rclonexBufferSize) || rclonexBufferSize < 0) {
      logger.warn(
        `rclonex_archive_buffer_size is invalid (${rawBuffer}); the buffer override is ignored`,
      );
    } else if (rclonexBufferSize > 0) {
      rclonexFlags.push(
        "--archive-window-size",
        String(Math.floor(rclonexBufferSize)),
      );
    }
    const autoSkipKnown = (cfg["auto_skip_known"] ?? "1") === "1";
    const trashSubdir = trashSubdirValidated;
    const trashDir = normalizeRel(trashSubdir);
    const fingerprint = configFingerprint(cfg);
    const cacheKey = cfg["scan_cache_key"] ?? "";
    const cacheState = cfg["scan_cache_state"] ?? "incomplete";
    const reuseScan = cacheState === "complete" && cacheKey === fingerprint;
    if (!reuseScan && cacheState === "complete") {
      logger.info("no valid cached scan for these settings; scanning fresh");
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
    if (!reuseScan && !skipListingAtStart) {
      // One line per fresh listing; the per-run "ignored N archive(s)"
      // counts stay at zero because rclone pre-filters out of range.
      const filterNotes = ["--ignore-case", "--include (archive extensions)"];
      if (minArchiveSize > 0) filterNotes.push(`--min-size ${minArchiveSize}B`);
      if (maxArchiveSize > 0) filterNotes.push(`--max-size ${maxArchiveSize}B`);
      logger.info(`listing filters: ${filterNotes.join(", ")}`);
    }
    const listed =
      reuseScan || skipListingAtStart
        ? null
        : await rc.list(async (rel, size) => {
      await touchRun(runRowId);
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
      // those are re-queued too (for re-inspection).
      const knownSkip =
        prev.status === "skipped" &&
        (prev.error_kind === "torrent" || prev.error_kind === "website");
      const shouldRequeue =
        prev.status === "done" || (!autoSkipKnown && knownSkip);
      if (shouldRequeue) {
        await store.run(
          "UPDATE archives SET size=?, status='queued', error_kind=NULL, updated_at=? WHERE path=?",
          [size, now(), rel],
        );
        existing.set(rel, { path: rel, status: "queued", error_kind: null });
        queued++;
      }
    }, { minSizeBytes: minArchiveSize, maxSizeBytes: maxArchiveSize });

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
          engineState.forceStop ||
          engineState.stopRequested ||
          (await getSetting("cancel", "0")) === "1";
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
          engineState.forceStop ||
          engineState.stopRequested ||
          (await getSetting("cancel", "0")) === "1";
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
        await setSetting("scan_cache_key", fingerprint);
        await setSetting("scan_cache_state", "complete");
      }
      if (listed.stderr.trim()) {
        warn(`listing stderr: ${listed.stderr.trim()}`);
      }
      logger.info(`listing complete: ${queued} new/requeued archive(s)`);
    }

    engineState.stage = "queueing";
    setActivity("Building queue");
    const sortBy = (cfg["sort_by"] ?? "path") === "size" ? "size" : "path";
    const sortDir = (cfg["sort_dir"] ?? "asc") === "desc" ? "DESC" : "ASC";
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

    // Per-worker runners. Each points at this run's private conf snapshot;
    // a worker binds its runner to the job in flight so a targeted skip kills
    // only that job's processes.
    const makeRunners = async () => {
      const rc = await Rclone.fromSettings(logger, runConf ? { confPath: runConf } : {});
      const rx = rclonexEnabled
        ? await Rclone.fromSettings(
            logger,
            runConf ? { rclonex: true, confPath: runConf } : { rclonex: true },
          )
        : null;
      return { rc, rx };
    };

    engineState.concurrency = clampConcurrency(cfg["concurrency"] ?? "1");
    logger.info(`concurrency=${engineState.concurrency}`);

    // One entry per (directory, archive family) in this run, shared by every
    // job of the group so the anchor's verdict decides the rest of the series.
    const groupStates = new Map<string, GroupState>();

    // Ordered jobs and their group predecessor. A job waits for its
    // predecessor to finish: different groups run in parallel, but the
    // first-in-queue archive of a group always stays the anchor.
    const predecessors = new Map<number, number | null>();
    const lastByGroup = new Map<string, number>();
    rows.forEach((row, order) => {
      const baseName = baseNameOf(row.path);
      const family = archiveFamily(baseName);
      const groupKey = family === null ? null : `${dirOfRel(row.path)}|${family}`;
      let predecessor: number | null = null;
      if (groupKey !== null) {
        predecessor = lastByGroup.get(groupKey) ?? null;
        lastByGroup.set(groupKey, row.id);
      }
      predecessors.set(row.id, predecessor);
      engineState.jobs.set(row.id, {
        id: row.id,
        rel: row.path,
        order,
        status: "queued",
        phase: "",
        command: "",
        stats: null,
        skipArchive: false,
        skipInspection: false,
        groupKey,
        finishedAt: "",
      });
    });

    const isTerminal = (s: JobStatus) =>
      s === "done" || s === "failed" || s === "skipped";

    const claimNext = (): JobState | undefined => {
      for (const job of engineState.jobs.values()) {
        if (job.status !== "queued") continue;
        const pred = predecessors.get(job.id) ?? null;
        if (pred !== null && !isTerminal(engineState.jobs.get(pred)?.status ?? "queued")) {
          continue;
        }
        // Claim atomically: the worker awaits a DB read right after this, so
        // the status must change now or another worker takes the same job.
        job.status = "active";
        return job;
      }
      return undefined;
    };

    // Atomic increments: parallel finishes cannot lose an update.
    const recordOutcome = async (
      job: JobState,
      result: "done" | "failed" | "skipped",
    ) => {
      job.status = result;
      job.finishedAt = now();
      if (result === "done") engineState.done++;
      else if (result === "skipped") engineState.skipped++;
      else engineState.failed++;
      const column = result === "done" ? "done" : result === "skipped" ? "skipped" : "failed";
      await store.run(`UPDATE runs SET ${column}=${column}+1 WHERE id=?`, [runRowId]);
    };

    // A single-flight drain: parallel job boundaries must not apply a queued
    // password move twice.
    let drainChain: Promise<void> = Promise.resolve();
    const drainOnce = (): Promise<void> => {
      drainChain = drainChain.then(() => drainDeferredPasswordMoves()).catch(() => {});
      return drainChain;
    };

    const processArchive = async (
      job: JobState,
      rc: Rclone,
      rclonexRc: Rclone | null,
    ) => {
      const row = { id: job.id, path: job.rel };

      // Skip flags are set on this job by targeted requests and cleared
      // when the worker claims it.
      const rel = row.path;
      // Defense in depth: rows enqueued by older versions could hold paths
      // that are unsafe to pass to rclone. Fail them instead of executing.
      if (!isSafeRel(rel)) {
        await store.run(
          "UPDATE archives SET status='failed', error_kind='unsafe_path', updated_at=? WHERE id=?",
          [now(), row.id],
        );
        await markRunTouch(Number(row.id), runRowId);
        // No binary output exists; store the webapp diagnostic so the
        // error row's Copy/Download shows something instead of a 404.
        await insertLogLines(
          { scope: "archive", refId: row.id, kind: "extract" },
          [`unsafe archive path rejected by app: ${JSON.stringify(rel)}`],
        ).catch(() => {});
        warn(`skipped unsafe stored path: ${JSON.stringify(rel)}`);
        await recordOutcome(job, "failed");
        return;
      }
      job.phase = "";
      job.stats = null;
      engineState.activeIds.add(job.id);
      // Persist before the first binary starts so a crash/kill still leaves
      // "which archive was in flight" behind for the Progress page.
      void store
        .run("UPDATE runs SET last_archive=? WHERE id=?", [rel, runRowId])
        .catch(() => {});
      await store.run(
        "UPDATE archives SET status='extracting', updated_at=? WHERE id=?",
        [now(), row.id],
      );
      await markRunTouch(Number(row.id), runRowId);

      const baseName = baseNameOf(rel);
      // Family of the rclone-handled archive this archive is; null for
      // RcloneX formats (they keep their existing always-extract-first
      // behavior). The group key is the exact parent directory — not
      // recursive. Grouping is per family and per run, never persisted.
      const family = archiveFamily(baseName);
      const groupKey =
        family === null ? null : `${dirOfRel(rel)}|${family}`;
      let group: GroupState | undefined;
      if (groupKey !== null) {
        group = groupStates.get(groupKey);
        if (!group) {
          group = { ref: null, open: false };
          groupStates.set(groupKey, group);
        }
      }
      // A "rest of the group" archive is extracted first and inspected on
      // the extracted tree, provided the first archive already passed
      // inspection and this name is related to it (incremental/decremental
      // series or otherwise similar filenames).
      let extractFirst = false;
      if (
        group &&
        group.ref !== null &&
        group.open &&
        namesRelated(group.ref, baseName)
      ) {
        extractFirst = true;
      }
      // The setting gates which formats are queued and which skip
      // pre-inspection, but once enabled every supported archive is extracted
      // with rclonex (including ZIP/TAR). Rclone stays responsible for
      // listing, inspection, promotion, cleanup and trash.
      const useRclonex = rclonexEnabled && isRclonexFormat(baseName);
      const extractor = rclonexRc ?? rc;
      const tmp = tmpStemDir(tmpRoot, runRowId, row.id, stem(baseName));
      const archiveTmpDir = tmpArchiveDir(tmpRoot, runRowId, row.id);
      const ref = { scope: "archive" as const, refId: row.id, kind: "extract" as const };
      let result: "done" | "failed" | "skipped" = "failed";
      let tmpAttempted = false;

      try {
        // Inspect the archive before any extraction happens. Archives that
        // match the skip rules (empty, torrent, website, tiny) or cannot be
        // read are skipped and never extracted. For RcloneX-handled formats
        // the archive itself cannot be cheaply listed, so inspection is
        // skipped up front and the extracted tree is checked instead
        // (website dumps / torrent collections are purged from the temp
        // dir, archive stays in place). ISO is not listable by
        // mholt/archives, so it also takes this fast path. The same
        // extract-first path applies to the "rest of the group" rule below:
        // archives in the same directory with a similar name of the same
        // archive family as an archive already inspected this run are
        // extracted first and inspected on the extracted tree — but only
        // when the group's first archive passed inspection. Unrelated
        // names, different families, and groups whose first archive failed
        // inspection are pre-inspected as usual. A per-archive
        // "Skip inspection" request still passes the inspection through here
        // for rclone-handled formats.
        const stats = createArchiveStats();
        let inspectionDetail: string | null = null;
        let skipReason: SkipReason | "unreadable" | "password" | null = null;
        if (job.skipInspection) {
          job.skipInspection = false; // consumed by this archive only
          extractFirst = false; // skip means no inspection at all, either side
          logger.info(`inspection skipped by user: ${rel}`);
          noteGroupInspection(group, baseName, true);
        } else if (useRclonex || /\.iso$/i.test(baseName)) {
          logger.info(`skipping archive inspection for ${rel} (rclonex)`);
        } else if (extractFirst) {
          // Anchor archive already inspected this run and this name is part
          // of the same series — extract first, inspect the tree after.
          logger.info(
            `inspection deferred to post-extract for ${rel} (similar to ${group!.ref} — first of this series already inspected this run)`,
          );
        } else {
          // Inspection always goes through the rclone binary: upstream's
          // `archive list` reads RAR/7Z fine, rclonex does not extend it and
          // would only add a full-stream re-read.
          setActivity("Inspecting archive", job);
          const listOut = await rc.archiveList(rel, ref, (entry) => {
            addArchiveEntry(stats, entry.path, entry.size);
            void touchRun(runRowId);
          });
          // Skip-archive takes precedence over the inspection outcome:
          // re-queue the archive instead of classifying/extracting it.
          throwIfSkipArchive(job);
          setActivity("", job);
          if (job.skipInspection) {
            // The user asked to skip while the listing was in flight; treat
            // the inspection as passed for this archive only.
            job.skipInspection = false;
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
          // A user skip mid-inspection is treated as passed (skipReason
          // stays null) — same semantics for the group anchor as for the
          // archive itself.
          noteGroupInspection(group, baseName, skipReason === null);
        }

        if (skipReason) {
          const detail = inspectionDetail ?? describeArchiveStats(stats);
          await store.run(
            "UPDATE archives SET status='skipped', error_kind=?, updated_at=? WHERE id=?",
            [skipReason, now(), row.id],
          );
          await markRunTouch(Number(row.id), runRowId);
          // The classification is a run-level diagnostic: per-archive logs
          // hold only what the binary actually printed.
          warn(`skipped (${skipReason}): ${rel} [${detail}]`);
          result = "skipped";
        } else {
        tmpAttempted = true;
        setActivity("Extracting", job);
        const ex = await withRetries(
          job,
          policy,
          () =>
            extractor.extract(
              rel,
              tmp,
              ref,
              statsTracker(runRowId, job),
              rclonexRc ? rclonexFlags : undefined,
            ),
          {
            label: `extract ${rel}`,
            log: (line) => logger.info(line),
            // A password failure is a terminal skip, not a transient error.
            retryable: (outcome) =>
              !PASSWORD_ERROR.test(`${outcome.tail.join("\n")}\n${outcome.stderr}`),
            // Partial output from a failed attempt must not feed the next one.
            beforeRetry: async () => {
              await rc.purge(tmp, ref);
            },
          },
        );
        setActivity("", job);
        throwIfSkipArchive(job);

        if (ex.code !== 0) {
          const all = `${ex.tail.join("\n")}\n${ex.stderr}`;
          if (PASSWORD_ERROR.test(all)) {
            await store.run(
              "UPDATE archives SET status='skipped', error_kind='password', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            await markRunTouch(Number(row.id), runRowId);
            warn(`skipped (password): ${rel} [$ ${ex.command}]`);
            result = "skipped";
          } else {
            setActivity("Cleaning up", job);
            await rc.cleanup(tmp, ref);
            setActivity("", job);
            throwIfSkipArchive(job);
            await store.run(
              "UPDATE archives SET status='failed', error_kind='extract', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            await markRunTouch(Number(row.id), runRowId);
            fail(
              `extract failed: ${rel}`,
              `$ ${ex.command}\n${ex.tail.join("\n")}`.trim(),
            );
          }
        } else {
          // Post-extraction inspection for rclonex-handled formats and for
          // "rest of the group" archives deferred by the per-directory rule:
          // the archive itself cannot be cheaply listed (rclonex), or was
          // deliberately extracted first, so the extracted tree is checked
          // instead. Website dumps and torrent collections are skipped
          // after extraction — the extracted data is removed and the
          // archive stays in place (never promoted, never trashed).
          // Anything else continues as a normal extraction.
          let postSkip: "website" | "torrent" | null = null;
          const exStats = createArchiveStats();
          if (useRclonex || extractFirst) {
            setActivity("Inspecting extracted files", job);
            const listOut = await rc.listPath(tmp, (p, size) =>
              addArchiveEntry(exStats, p, size),
            );
            setActivity("", job);
            throwIfSkipArchive(job);
            // A listing that failed partway through streamed partial data;
            // classification of a partial tree would purge it wrongly.
            const listFailed = Boolean(listOut.streamError) || listOut.code !== 0;
            if (listFailed) {
              warn(
                `post-extraction listing failed for ${rel} [$ ${listOut.command}]; continuing unclassified`,
              );
            } else if (exStats.total > 0) {
              const reason = classifyArchive(exStats);
              if (reason === "website" || reason === "torrent") {
                postSkip = reason;
              }
            }
          }
          if (postSkip) {
            setActivity("Cleaning up", job);
            const purged = await rc.purge(archiveTmpDir, ref);
            setActivity("", job);
            if (purged.code !== 0) {
              warn(
                `temp purge failed: ${archiveTmpDir} [$ ${purged.command}] ${purged.stderr.trim() || "unknown error"}`,
              );
            }
            await store.run(
              "UPDATE archives SET status='skipped', error_kind=?, updated_at=? WHERE id=?",
              [postSkip, now(), row.id],
            );
            await markRunTouch(Number(row.id), runRowId);
            warn(`skipped (${postSkip}): ${rel} [extracted tree]`);
            result = "skipped";
          } else {
          setActivity("Moving to destination", job);
          const promoted = await withRetries(
            job,
            policy,
            () => rc.promote(rel, tmp, ref, tmpTop, statsTracker(runRowId, job)),
            { label: `promote ${rel}`, log: (line) => logger.info(line) },
          );
          setActivity("", job);
          throwIfSkipArchive(job);
          if (promoted.code !== 0) {
            setActivity("Cleaning up", job);
            await rc.cleanup(tmp, ref);
            setActivity("", job);
            throwIfSkipArchive(job);
            await store.run(
              "UPDATE archives SET status='failed', error_kind='promote', updated_at=? WHERE id=?",
              [now(), row.id],
            );
            await markRunTouch(Number(row.id), runRowId);
            fail(
              `promote failed: ${rel}`,
              `$ ${promoted.command}\n${promoted.tail.join("\n")}`.trim(),
            );
          } else {
            setActivity("Cleaning up", job);
            const cleaned = await rc.cleanup(tmp, ref);
            setActivity("", job);
            if (cleaned.code !== 0) {
              warn(
                `cleanup failed: ${rel} [$ ${cleaned.command}] ${cleaned.stderr.trim()}`,
              );
            }
            // A skip asked while the cleanup ran must not move the archive to
            // trash — without this guard the archive was extracted, promoted
            // and trashed, then re-queued anyway.
            throwIfSkipArchive(job);

            setActivity("Moving to trash", job);
            const trashed = await withRetries(
              job,
              policy,
              () => rc.trash(rel, trashSubdir, ref, statsTracker(runRowId, job)),
              { label: `trash ${rel}`, log: (line) => logger.info(line) },
            );
            setActivity("", job);
            if (trashed.code !== 0) {
              // The move did not complete, so the existing skip unwind still
              // applies.
              throwIfSkipArchive(job);
              await store.run(
                "UPDATE archives SET status='failed', error_kind='trash', updated_at=? WHERE id=?",
                [now(), row.id],
              );
              await markRunTouch(Number(row.id), runRowId);
              fail(
                `trash failed: ${rel}`,
                `$ ${trashed.command}\n${trashed.tail.join("\n")}`.trim(),
              );
            } else {
              // The file is in trash; a skip cannot put it back. Consume the
              // flag so the archive finalizes as done instead of re-queued.
              job.skipArchive = false;
              await store.run(
                "UPDATE archives SET status='done', error_kind=NULL, updated_at=? WHERE id=?",
                [now(), row.id],
              );
              await markRunTouch(Number(row.id), runRowId);
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
          job.skipArchive = false; // consumed by this archive
          await store.run(
            "UPDATE archives SET status='queued', error_kind=NULL, updated_at=? WHERE id=? AND status NOT IN ('done','skipped')",
            [now(), row.id],
          );
          await markRunTouch(Number(row.id), runRowId);
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
        await markRunTouch(Number(row.id), runRowId);
        // No binary output exists when the webapp itself throws (spawn
        // failure, DB error, ...); store the diagnostic so the error row's
        // Copy/Download is not empty.
        await insertLogLines(ref, [`archive error: ${String(e)}`]).catch(() => {});
        fail(`archive error: ${rel}`, String(e));
        }
      } finally {
        engineState.activeIds.delete(job.id);
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
            await markRunTouch(Number(row.id), runRowId);
          job.status = "queued";
          job.command = "";
          job.stats = null;
          job.phase = "";
        } else {
          job.status = "queued";
          job.command = "";
          job.stats = null;
          job.phase = "";
          await recordOutcome(job, result);
        }
        // Best effort: purge the per-archive temp dir with whatever is left
        // in it. Only ever called on the app-owned archive dir.
        if (tmpAttempted) {
          setActivity("Cleaning up", job);
          const purged = await rc.purge(archiveTmpDir, ref);
          setActivity("", job);
          if (purged.code !== 0) {
            warn(
              `temp purge failed: ${archiveTmpDir} [$ ${purged.command}] ${purged.stderr.trim() || "unknown error"}`,
            );
          }
        }
      }
    };

    const workers = Array.from({ length: engineState.concurrency }, async () => {
      const { rc, rx } = await makeRunners();
      while (true) {
        if (
          engineState.stopRequested ||
          engineState.forceStop ||
          (await cancelRequestedCached())
        ) {
          break;
        }
        const job = claimNext();
        if (!job) break;
        // Clear-queues maintenance may have removed this row while the run was
        // in flight. Treat it as terminal so its group successors unblock.
        const current = await store.get1<{ status: string }>(
          "SELECT status FROM archives WHERE id=?",
          [job.id],
        );
        if (!current || current.status !== "queued") {
          logger.info(`skipping ${job.rel} (queue cleared)`);
          job.status = "skipped";
          continue;
        }
        job.phase = "";
        job.stats = null;
        engineState.activeIds.add(job.id);
        rc.setProcOwner(job.id);
        rx?.setProcOwner(job.id);
        rc.onCommand = (command) => persistCommand(command, job);
        if (rx) rx.onCommand = (command) => persistCommand(command, job);
        refreshPrimaryMirror();
        try {
          await processArchive(job, rc, rx);
        } finally {
          engineState.activeIds.delete(job.id);
          rc.setProcOwner(null);
          rx?.setProcOwner(null);
          refreshPrimaryMirror();
          await drainOnce();
        }
      }
    });
    await Promise.all(workers);

    // Best effort: purge only this run's temp dir, which may still hold
    // extracted data (e.g. an archive was force-stopped mid-flight). Never
    // purge the shared temp root: it may hold other runs' data.
    setActivity("Cleaning up");
    const tmpRootNorm = tmpRoot.replace(/\/+$/, "");
    const runDir = tmpRunDir(tmpRootNorm, runRowId);
    const tmpRootIsSafe =
      tmpRootNorm.length > 1 &&
      tmpRootNorm !== "/" &&
      !tmpRootNorm.endsWith(":") &&
      !/^[A-Za-z]:[\\/]?$/.test(tmpRootNorm) &&
      runDir === tmpRunDir(tmpRootNorm, runRowId);
    if (tmpRootIsSafe) {
      const purged = await rc.purge(runDir);
      if (purged.code === 0) {
        logger.info(`purged ${runDir}`);
      } else {
        logger.info(`left ${runDir} in place (${purged.stderr.trim() || "purge failed"})`);
      }
    } else {
      logger.info(`left ${runDir} in place (temp root not safe to purge)`);
    }
    setActivity("");

    // A move accepted after the last per-archive drain (or with no archives
    // at all) would otherwise be lost when this run finalizes.
    await drainDeferredPasswordMoves();

    // A stop requested while the last archive was being processed never gets
    // another loop iteration to notice it, so decide here. A user-stopped run
    // ends as outcome='interrupted' (reason names the stop mode); a clean run
    // ends as 'finished'.
    engineState.stage = engineState.stopRequested ? "interrupted" : "finished";
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
    if (runConf) {
      // The run is over; the private rclone.conf snapshot has served its
      // purpose. Delete it so credentials don't outlive the run.
      deleteRunConfSnapshot(runConf);
    }
    engineState.running = false;
    engineState.currentCommand = "";
    engineState.activity = "";
    engineState.stopRequested = false;
    engineState.forceStop = false;
    engineState.skipListing = false;
    engineState.archiveInFlight = false;
  }
}
