import { Hono } from "hono";
import { engineState } from "../engine";
import { store, getSetting } from "../db";
import { esc, toastTriggerHeaders, fmtDisplayTime, info } from "../ui";
import { formatBytes, formatRate, formatDuration } from "../format";
import { resolveOutcome } from "../runs";
import type { ExtractStats } from "../rclone";
import { pendingRcloneConfNotice } from "../rclone";
import { controlsFragment } from "../views";

export const dashboard = new Hono();

interface JobView {
  id: number;
  name: string;
  path: string;
  status: string;
  phase: string;
  command: string;
  stats: ExtractStats | null;
}

interface Snapshot {
  running: boolean;
  runId: number;
  stage: string;
  lastArchive: string;
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
  interruptReason: string;
  outcome: string;
  errorKind: string;
  concurrency: number;
  queued: number;
  active: number;
  jobs: JobView[];
  upcoming: { order: number; id: number; path: string }[];
}

function jobViews(): { jobs: JobView[]; upcoming: { order: number; id: number; path: string }[] } {
  const jobs: JobView[] = [];
  const upcoming: { order: number; id: number; path: string }[] = [];
  for (const job of engineState.jobs.values()) {
    if (job.status === "queued") {
      upcoming.push({ order: job.order + 1, id: job.id, path: job.rel });
      continue;
    }
    jobs.push({
      id: job.id,
      name: job.rel.slice(job.rel.lastIndexOf("/") + 1),
      path: job.rel,
      status: job.status,
      phase: job.phase,
      command: job.command,
      stats: job.stats,
    });
  }
  upcoming.sort((a, b) => a.order - b.order);
  return { jobs, upcoming };
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
  const liveRoot =
    engineState.running && engineState.currentScanRoot
      ? engineState.currentScanRoot
      : null;
  const scanRoot = liveRoot ?? ((await getSetting("scan_root", "")) ?? "");
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
      concurrency: engineState.concurrency,
      queued: [...engineState.jobs.values()].filter((j) => j.status === "queued").length,
      active: engineState.activeIds.size,
      ...jobViews(),
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
      concurrency: 1,
      queued: 0,
      active: 0,
      jobs: [],
      upcoming: [],
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
    concurrency: 1,
    queued: 0,
    active: 0,
    jobs: [],
    upcoming: [],
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

function jobStatusClass(status: string): string {
  if (status === "done") return "is-done";
  if (status === "failed") return "is-error";
  if (status === "skipped") return "is-interrupted";
  if (status === "active") return "is-running";
  return "";
}

function jobPillClass(status: string): string {
  if (status === "done") return "ok";
  if (status === "failed") return "err";
  if (status === "skipped") return "warn";
  return "";
}

function jobBar(job: JobView): string {
  const st = job.stats;
  if (!st) {
    if (job.status !== "active") return "";
    return `<div class="extract-mini">
      <div class="extract-mini-head"><span class="extract-mini-label">${esc(job.phase || "Working")}</span></div>
      <div class="minibar is-indeterminate" role="progressbar" aria-label="${esc(job.name)} — ${esc(job.phase || "working")}"><span></span></div>
    </div>`;
  }
  const pctText = st.percent === null ? "—" : `${Math.round(st.percent)}%`;
  const width = st.percent === null ? 0 : Math.max(0, Math.min(100, st.percent));
  const eta = st.etaText ? st.etaText : "—";
  return `<div class="extract-mini">
    <div class="extract-mini-head">
      <span class="extract-mini-label">${esc(job.phase || "Transfer")}</span>
      <span class="extract-mini-value">${esc(formatBytes(st.bytesDone))} / ${esc(formatBytes(st.bytesTotal))} · ${esc(pctText)} · ${esc(formatRate(st.speedBytesPerSec))} · ETA ${esc(eta)}</span>
    </div>
    <div class="minibar" role="progressbar" aria-label="${esc(job.name)} transfer" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(width)}"><span style="width:${width.toFixed(1)}%"></span></div>
  </div>`;
}

function jobCards(jobs: JobView[]): string {
  if (jobs.length === 0) return "";
  const cards = jobs
    .map((job) => {
      const label = job.phase || stageLabel(job.status);
      const skip =
        job.status === "active"
          ? `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"archive","id":"${job.id}"}' hx-target="#controls" hx-swap="outerHTML">Skip archive</button>`
          : "";
      return `<article class="card job-card ${jobStatusClass(job.status)}">
        <div class="job-card-head">
          <span class="status-badge ${jobStatusClass(job.status)}"><span class="dot"></span>${esc(label)}</span>
          <span class="pill ${jobPillClass(job.status)}">${esc(job.status)}</span>
        </div>
        <div class="error-name" title="${esc(job.path)}">${esc(job.name)}</div>
        <div class="error-path muted">${esc(job.path)}</div>
        ${jobBar(job)}
        ${skip ? `<div class="job-card-foot">${skip}</div>` : ""}
      </article>`;
    })
    .join("");
  return `<div class="job-section">
    <h3 class="job-section-title">Archives in flight</h3>
    <div class="job-grid">${cards}</div>
  </div>`;
}

function upcomingTable(rows: { order: number; id: number; path: string }[]): string {
  if (rows.length === 0) return "";
  const body = rows
    .map(
      (r) =>
        `<tr><td class="queue-order">${r.order}</td><td title="${esc(r.path)}">${esc(r.path)}</td></tr>`,
    )
    .join("");
  return `<div class="job-section">
    <h3 class="job-section-title">Upcoming archives <span class="muted">(${rows.length})</span></h3>
    <div class="queue-scroll"><table class="queue-table">
      <thead><tr><th scope="col">#</th><th scope="col">Archive</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
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
  const label = s.activity || stageLabel(s.stage);
  const archive = s.lastArchive || "—";
  const command = s.lastCommand || "—";
  const archiveLabel = s.running ? "Current archive" : "Last archive";
  const commandLabel = s.running ? "Active command" : "Last command";
  const mutedNote =
    s.total === 0 && s.stage === "finished"
      ? `<p class="muted">No matching archives were found in this run.</p>`
      : "";
  const stopNote =
    s.running && engineState.stopRequested
      ? engineState.forceStop
        ? `<p class="warn-line">Stopping immediately — all in-flight archives were aborted.</p>`
        : `<p class="warn-line">Stop requested — in-flight archives finish first, then the task stops. Click <strong>Force stop</strong> to stop immediately.</p>`
      : "";
  const reason = s.interruptReason;
  const timeSuffix = s.finishedAt
    ? ` · ${esc(fmtDisplayTime(s.finishedAt, true))}`
    : "";
  const code = s.errorKind && s.errorKind !== s.outcome ? ` (${esc(s.errorKind)})` : "";
  const outcomeNote =
    s.outcome === "interrupted"
      ? `<p class="warn-line">Interrupted${code} — ${esc(reason || "stopped by user")}${timeSuffix}.</p>`
      : s.outcome === "killed"
        ? `<p class="warn-line">Killed${code} — ${esc(reason || "previous process exited mid-run")}${timeSuffix}. In-progress archives resume on the next start when resume is enabled.</p>`
        : s.outcome === "error"
          ? `<p class="warn-line">Error — ${esc(s.errorKind || "engine_error")}${reason ? `: ${esc(reason)}` : ""}${timeSuffix}. See the Logs page (Errors tab) for details.</p>`
          : "";
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
      ${statCard("Queued", s.queued, s.total, "remain")}
      ${statCard("Active", s.active, s.total, "ok")}
      ${statCard("Concurrency", s.concurrency, 0, "")}
      ${statCard("Done", s.done, s.total, "ok")}
      ${statCard("Failed", s.failed, s.total, "err")}
      ${statCard("Skipped", s.skipped, s.total, "warn")}
    </div>

    ${jobCards(s.jobs)}
    ${upcomingTable(s.upcoming)}

    <dl class="detail-grid">
      <div>
        <dt>Scan root</dt>
        <dd>${esc(s.scanRoot || "—")} ${info("rclone remote or local path this app scans.", "Scan root")}</dd>
      </div>
      <div>
        <dt>${archiveLabel}</dt>
        <dd title="${esc(archive)}">${esc(archive)} ${info("Archive currently being processed (this run's last one when idle).", archiveLabel)}</dd>
      </div>
      <div>
        <dt>${commandLabel}</dt>
        <dd class="cmd" title="${esc(command)}">${esc(command)} ${info("rclone command currently running (or the last one that ran).", commandLabel)}</dd>
      </div>
      <div>
        <dt>Rate</dt>
        <dd>${esc(rateLabel(processed, elapsedMs))} ${info("Archives processed per minute (done + failed + skipped).", "Rate")}</dd>
      </div>
      <div>
        <dt>ETA</dt>
        <dd>${esc(etaLabel(processed, s.total, elapsedMs))} ${info("Estimated time to finish the remaining queue.", "ETA")}</dd>
      </div>
    </dl>

    ${mutedNote}
    ${outcomeNote}
    ${stopNote}
    ${s.lastError ? `<p class="err-line">${esc(s.lastError)}</p>` : ""}
  </section>`;
}

dashboard.get("/dashboard/fragment", async (c) => {
  const confNotice = pendingRcloneConfNotice();
  return c.html(
    await progressPanel(),
    200,
    confNotice ? toastTriggerHeaders(confNotice, "err") : undefined,
  );
});
dashboard.get("/dashboard/controls", (c) => c.html(controlsFragment()));
