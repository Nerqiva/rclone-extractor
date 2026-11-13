import { Hono } from "hono";
import { engineState } from "../engine";
import { store, getSetting } from "../db";
import { esc, toastTriggerHeaders, fmtDisplayTime } from "../ui";
import { formatBytes, formatRate, formatDuration } from "../format";
import { resolveOutcome } from "../runs";
import type { ExtractStats } from "../rclone";
import { pendingRcloneConfNotice } from "../rclone";
import { controlsFragment } from "../views";

export const dashboard = new Hono();

interface Snapshot {
  running: boolean;
  runId: number;
  stage: string;
  /** Archive in flight (live) or the last one processed (not running). */
  lastArchive: string;
  /** Command in flight (live) or the last one dispatched (not running). */
  lastCommand: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  lastError: string;
  scanRoot: string;
  commandStats: ExtractStats | null;
  activity: string;
  /** Why the run was closed abnormally ("" for normal runs). */
  interruptReason: string;
  /** '' while running/legacy, else finished|interrupted|killed|error. */
  outcome: string;
  /** App-error code; set for outcome === "error" and for interrupted/killed. */
  errorKind: string;
}

const STAGE_LABEL: Record<string, string> = {
  idle: "Idle",
  listing: "Listing archives",
  queueing: "Building queue",
  extracting: "Extracting",
  finished: "Completed",
  interrupted: "Interrupted",
  killed: "Killed",
  error: "Error",
};

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

function stateClass(stage: string, running: boolean): string {
  if (stage === "error") return "is-error";
  if (stage === "killed") return "is-killed";
  if (stage === "interrupted") return "is-interrupted";
  if (running) return "is-running";
  if (stage === "finished") return "is-done";
  return "is-idle";
}

function rateLabel(processed: number, elapsedMs: number): string {
  if (processed <= 0 || elapsedMs <= 0) return "—";
  return `${(processed / (elapsedMs / 60_000)).toFixed(1)}/min`;
}

function etaLabel(processed: number, total: number, elapsedMs: number): string {
  const remaining = Math.max(0, total - processed);
  if (remaining === 0) return "—";
  if (processed <= 0 || elapsedMs <= 0) return "—";
  const perItem = elapsedMs / processed;
  return formatDuration(perItem * remaining);
}

async function snapshot(): Promise<Snapshot> {
  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  // Prefer in-memory state while a run exists. Also surface startup errors that
  // happen before a run row can be created (for example a missing scan_root).
  if (engineState.runId > 0 || engineState.stage === "error") {
    return {
      running: engineState.running,
      runId: engineState.runId,
      stage: engineState.stage,
      lastArchive: engineState.currentRel,
      lastCommand: engineState.currentCommand,
      total: engineState.total,
      done: engineState.done,
      failed: engineState.failed,
      skipped: engineState.skipped,
      startedAt: engineState.startedAt,
      finishedAt: engineState.finishedAt,
      lastError: engineState.lastError,
      scanRoot,
      commandStats: engineState.commandStats,
      activity: engineState.activity,
      interruptReason:
        engineState.stage === "interrupted"
          ? engineState.interruptReason
          : engineState.lastError
            ? String(engineState.lastError)
            : "",
      outcome:
        engineState.stage === "interrupted"
          ? "interrupted"
          : engineState.stage === "error"
            ? "error"
            : engineState.stage === "finished"
              ? "finished"
              : "",
      errorKind: engineState.errorKind || "",
    };
  }

  const row = await store.get1<{
    id: number;
    started_at: string;
    finished_at: string | null;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    interrupted: number | null;
    interrupted_reason: string | null;
    outcome: string | null;
    error_kind: string | null;
    last_archive: string | null;
    last_command: string | null;
  }>(
    "SELECT id, started_at, finished_at, total, done, failed, skipped, interrupted, interrupted_reason, outcome, error_kind, last_archive, last_command FROM runs ORDER BY id DESC LIMIT 1",
  );
  if (!row) {
    return {
      running: false,
      runId: 0,
      stage: "idle",
      lastArchive: "",
      lastCommand: "",
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      startedAt: "",
      finishedAt: "",
      lastError: "",
      scanRoot,
      commandStats: null,
      activity: "",
      interruptReason: "",
      outcome: "",
      errorKind: "",
    };
  }

  const outcome = resolveOutcome(row);
  return {
    running: false,
    runId: Number(row.id),
    stage:
      outcome === "interrupted"
        ? "interrupted"
        : outcome === "killed"
          ? "killed"
          : outcome === "error"
            ? "error"
            : row.finished_at
              ? "finished"
              : "idle",
    lastArchive: row.last_archive ?? "",
    lastCommand: row.last_command ?? "",
    total: Number(row.total),
    done: Number(row.done),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? "",
    lastError: "",
    scanRoot,
    commandStats: null,
    activity: "",
    interruptReason: row.interrupted_reason ?? "",
    outcome,
    errorKind: row.error_kind ?? "",
  };
}

function statCard(
  label: string,
  value: number,
  total: number,
  cls: string,
): string {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return `<div class="stat-card ${cls}">
    <span class="stat-label">${esc(label)}</span>
    <strong class="stat-value">${value}</strong>
    <span class="stat-sub">${total > 0 ? `${pct}% of total` : "—"}</span>
  </div>`;
}

export async function progressPanel(): Promise<string> {
  const s = await snapshot();

  if (s.runId === 0 && s.stage !== "error") {
    return `<section class="progress-panel is-idle">
      <div class="empty-state">
        <h2>No tasks yet</h2>
        <p class="muted">Press Start to scan the configured remote and extract archives.</p>
        <p class="muted">Scan root: <code>${esc(s.scanRoot || "not set")}</code></p>
      </div>
    </section>`;
  }

  const processed = s.done + s.failed + s.skipped;
  const remaining = Math.max(0, s.total - processed);
  const pct = s.total > 0 ? Math.min(100, (processed / s.total) * 100) : 0;
  const donePct = s.total > 0 ? (s.done / s.total) * 100 : 0;
  const failedPct = s.total > 0 ? (s.failed / s.total) * 100 : 0;
  const skippedPct = s.total > 0 ? (s.skipped / s.total) * 100 : 0;
  const remainingPct = Math.max(0, 100 - donePct - failedPct - skippedPct);

  const start = Date.parse(s.startedAt);
  const end = s.finishedAt ? Date.parse(s.finishedAt) : Date.now();
  const elapsedMs =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
  const elapsed = formatDuration(elapsedMs);
  const cls = stateClass(s.stage, s.running);
  // While a command is in flight the badge names the command, not the
  // coarse stage ("Extracting" / "Moving to trash" / ...).
  const label = s.activity || stageLabel(s.stage);
  const archive = s.lastArchive || "—";
  const command = s.lastCommand || "—";
  // While a run is live the slots track it; otherwise they show what the
  // last (interrupted) run was doing when it stopped.
  const archiveLabel = s.running ? "Current archive" : "Last archive";
  const commandLabel = s.running ? "Active command" : "Last command";
  const mutedNote =
    s.total === 0 && s.stage === "finished"
      ? `<p class="muted">No matching archives were found in this run.</p>`
      : "";
  const stopNote =
    s.running && engineState.stopRequested
      ? engineState.forceStop
        ? `<p class="warn-line">Stopping immediately — the in-flight archive was aborted.</p>`
        : `<p class="warn-line">Stop requested — the current archive will finish, then the task stops. Click <strong>Force stop</strong> to stop immediately.</p>`
      : "";
  const reason = s.interruptReason;
  const timeSuffix = s.finishedAt
    ? ` · ${esc(fmtDisplayTime(s.finishedAt, true))}`
    : "";
  // A code that merely repeats the outcome ("killed (killed)") adds nothing;
  // only interrupted/error codes carry extra meaning.
  const code = s.errorKind && s.errorKind !== s.outcome ? ` (${esc(s.errorKind)})` : "";
  const outcomeNote =
    s.outcome === "interrupted"
      ? `<p class="warn-line">Interrupted${code} — ${esc(reason || "stopped by user")}${timeSuffix}.</p>`
      : s.outcome === "killed"
        ? `<p class="warn-line">Killed${code} — ${esc(reason || "previous process exited mid-run")}${timeSuffix}. In-progress archives resume on the next start when resume is enabled.</p>`
        : s.outcome === "error"
          ? `<p class="warn-line">Error — ${esc(s.errorKind || "engine_error")}${reason ? `: ${esc(reason)}` : ""}${timeSuffix}. See the Logs page (Errors tab) for details.</p>`
          : "";
  // One thin bar slot shared by every in-flight rclone command; transfer
  // commands (extract/move/moveto) show their live byte progress, everything
  // else shows an indeterminate sweep.
  const commandBlock = s.activity
    ? (() => {
        const st = s.commandStats;
        if (st) {
          const pctText = st.percent === null ? "—" : `${Math.round(st.percent)}%`;
          const width = st.percent === null ? 0 : Math.max(0, Math.min(100, st.percent));
          const eta = st.etaText ? st.etaText : "—";
          return `
    <div class="extract-mini">
      <div class="extract-mini-head">
        <span class="extract-mini-label">${esc(s.activity)}</span>
        <span class="extract-mini-value">${esc(formatBytes(st.bytesDone))} / ${esc(formatBytes(st.bytesTotal))} · ${esc(pctText)} · ${esc(formatRate(st.speedBytesPerSec))} · ETA ${esc(eta)}</span>
      </div>
      <div class="minibar" aria-hidden="true"><span style="width:${width.toFixed(1)}%"></span></div>
    </div>`;
        }
        return `
    <div class="extract-mini">
      <div class="extract-mini-head">
        <span class="extract-mini-label">${esc(s.activity)}</span>
      </div>
      <div class="minibar is-indeterminate" role="progressbar" aria-label="${esc(s.activity)}"><span></span></div>
    </div>`;
      })()
    : "";

  return `<section class="progress-panel ${cls}">
    <header class="run-header">
      <div class="run-identity">
        <span class="status-badge ${cls}"><span class="dot"></span>${esc(label)}</span>
        ${s.runId > 0 ? `<span class="run-id">Run #${s.runId}</span>` : ""}
        ${s.running ? `<span class="live-pill">Live</span>` : ""}
      </div>
      <div class="run-times">
        ${s.startedAt ? `<span>Started <strong>${esc(fmtDisplayTime(s.startedAt, true))}</strong></span>` : ""}
        <span>Elapsed <strong>${esc(elapsed)}</strong></span>
        ${s.finishedAt && !s.running ? `<span>Ended <strong>${esc(fmtDisplayTime(s.finishedAt, true))}</strong></span>` : ""}
      </div>
    </header>

    <div class="progress-main">
      <div class="progress-head">
        <span class="progress-label">Overall progress</span>
        <span class="progress-value">${Math.round(pct)}<span class="unit">%</span></span>
      </div>
      <div class="segbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
        <span class="seg seg-done" style="width:${donePct.toFixed(2)}%"></span>
        <span class="seg seg-failed" style="width:${failedPct.toFixed(2)}%"></span>
        <span class="seg seg-skipped" style="width:${skippedPct.toFixed(2)}%"></span>
        <span class="seg seg-remaining" style="width:${remainingPct.toFixed(2)}%"></span>
      </div>
      <div class="progress-legend">
        <span><i class="legend-dot ok"></i>Done ${s.done}</span>
        <span><i class="legend-dot err"></i>Failed ${s.failed}</span>
        <span><i class="legend-dot warn"></i>Skipped ${s.skipped}</span>
        <span><i class="legend-dot remain"></i>Remaining ${remaining}</span>
      </div>
      <div class="progress-count">${processed} of ${s.total} processed</div>
      ${commandBlock}
    </div>

    <div class="stat-grid">
      ${statCard("Done", s.done, s.total, "ok")}
      ${statCard("Failed", s.failed, s.total, "err")}
      ${statCard("Skipped", s.skipped, s.total, "warn")}
      ${statCard("Remaining", remaining, s.total, "remain")}
    </div>

    <dl class="detail-grid">
      <div>
        <dt>Scan root</dt>
        <dd>${esc(s.scanRoot || "—")}</dd>
      </div>
      <div>
        <dt>${archiveLabel}</dt>
        <dd title="${esc(archive)}">${esc(archive)}</dd>
      </div>
      <div>
        <dt>${commandLabel}</dt>
        <dd class="cmd" title="${esc(command)}">${esc(command)}</dd>
      </div>
      <div>
        <dt>Rate</dt>
        <dd title="Archives processed per minute (done + failed + skipped)">${esc(rateLabel(processed, elapsedMs))}</dd>
      </div>
      <div>
        <dt>ETA</dt>
        <dd title="Estimated time to finish the remaining queue">${esc(etaLabel(processed, s.total, elapsedMs))}</dd>
      </div>
    </dl>

    ${mutedNote}
    ${outcomeNote}
    ${stopNote}
    ${s.lastError ? `<p class="err-line">${esc(s.lastError)}</p>` : ""}
  </section>`;
}

dashboard.get("/dashboard/fragment", async (c) => {
  // Boot-time rclone.conf fallbacks set a notice that only HTTP responses
  // can toast; surface it here (polled every second on the Progress page).
  const confNotice = pendingRcloneConfNotice();
  return c.html(
    await progressPanel(),
    200,
    confNotice ? toastTriggerHeaders(confNotice, "err") : undefined,
  );
});
dashboard.get("/dashboard/controls", (c) => c.html(controlsFragment()));
