import { Hono } from "hono";
import { engineState } from "../engine";
import { store, getSetting } from "../db";
import { esc, toastTriggerHeaders, fmtDisplayTime } from "../ui";
import type { ExtractStats } from "../rclone";
import { pendingRcloneConfNotice } from "../rclone";
import { controlsFragment } from "./actions";

export const dashboard = new Hono();

interface Snapshot {
  running: boolean;
  runId: number;
  stage: string;
  currentRel: string;
  currentCommand: string;
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
  /** App-error code; set only when outcome === "error". */
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
  cancelled: "Cancelled",
  error: "Error",
};

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

function stateClass(stage: string, running: boolean): string {
  if (stage === "error") return "is-error";
  if (stage === "killed") return "is-killed";
  if (stage === "cancelled") return "is-cancelled";
  if (stage === "interrupted") return "is-interrupted";
  if (running) return "is-running";
  if (stage === "finished") return "is-done";
  return "is-idle";
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  return `${fmtBytes(bytesPerSec)}/s`;
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
  return duration(perItem * remaining);
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
      currentRel: engineState.currentRel,
      currentCommand: engineState.currentCommand,
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
        engineState.stage === "interrupted" || engineState.stage === "cancelled"
          ? engineState.stopReason
          : engineState.lastError
            ? String(engineState.lastError)
            : "",
      outcome:
        engineState.stage === "interrupted" || engineState.stage === "cancelled"
          ? "interrupted"
          : engineState.stage === "error"
            ? "error"
            : engineState.stage === "finished"
              ? "finished"
              : "",
      errorKind: engineState.errorCode || "",
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
  }>(
    "SELECT id, started_at, finished_at, total, done, failed, skipped, interrupted, interrupted_reason, outcome, error_kind FROM runs ORDER BY id DESC LIMIT 1",
  );
  if (!row) {
    return {
      running: false,
      runId: 0,
      stage: "idle",
      currentRel: "",
      currentCommand: "",
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

  // Prefer the stored outcome; fall back to the legacy interrupted flag for
  // rows written before it existed.
  const outcome =
    row.outcome && row.outcome !== ""
      ? row.outcome
      : Number(row.interrupted ?? 0) === 1
        ? "killed"
        : row.finished_at
          ? "finished"
          : "";
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
    currentRel: "",
    currentCommand: "",
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
  const elapsed = duration(elapsedMs);
  const cls = stateClass(s.stage, s.running);
  // While a command is in flight the badge names the command, not the
  // coarse stage ("Extracting" / "Moving to trash" / ...).
  const label = s.activity || stageLabel(s.stage);
  const current = s.currentRel || "—";
  const command = s.currentCommand || "—";
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
  const outcomeNote =
    s.outcome === "interrupted"
      ? `<p class="warn-line">Interrupted — ${esc(reason || "stopped by user")}${timeSuffix}.</p>`
      : s.outcome === "killed"
        ? `<p class="warn-line">Killed — ${esc(reason || "previous process exited mid-run")}${timeSuffix}. In-progress archives resume on the next start when resume is enabled.</p>`
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
        <span class="extract-mini-value">${esc(fmtBytes(st.bytesDone))} / ${esc(fmtBytes(st.bytesTotal))} · ${esc(pctText)} · ${esc(fmtRate(st.speedBytesPerSec))} · ETA ${esc(eta)}</span>
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
        <dt>Current archive</dt>
        <dd title="${esc(current)}">${esc(current)}</dd>
      </div>
      <div>
        <dt>Active command</dt>
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
