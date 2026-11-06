import { Hono } from "hono";
import { engineState } from "../engine";
import { store, getSetting } from "../db";
import { esc } from "../ui";
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
}

const STAGE_LABEL: Record<string, string> = {
  idle: "Idle",
  searching: "Scanning remote",
  listing: "Listing archives",
  queueing: "Building queue",
  extracting: "Extracting",
  finished: "Completed",
  cancelled: "Cancelled",
  error: "Failed",
};

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

function stateClass(stage: string, running: boolean): string {
  if (stage === "error") return "is-error";
  if (stage === "cancelled") return "is-cancelled";
  if (running) return "is-running";
  if (stage === "finished") return "is-done";
  return "is-idle";
}

function clock(ts: string): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  return `${new Date(t).toISOString().slice(11, 19)} UTC`;
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
  }>(
    "SELECT id, started_at, finished_at, total, done, failed, skipped FROM runs ORDER BY id DESC LIMIT 1",
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
    };
  }

  return {
    running: false,
    runId: Number(row.id),
    stage: row.finished_at ? "finished" : "idle",
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
  const elapsed = s.running ? duration(Date.now() - start) : duration(elapsedMs);
  const cls = stateClass(s.stage, s.running);
  const label = stageLabel(s.stage);
  const current = s.currentRel || "—";
  const command = s.currentCommand || "—";
  const mutedNote =
    s.total === 0 && s.stage === "finished"
      ? `<p class="muted">No matching archives were found in this run.</p>`
      : "";

  return `<section class="progress-panel ${cls}">
    <header class="run-header">
      <div class="run-identity">
        <span class="status-badge ${cls}"><span class="dot"></span>${esc(label)}</span>
        ${s.runId > 0 ? `<span class="run-id">Run #${s.runId}</span>` : ""}
        ${s.running ? `<span class="live-pill">Live</span>` : ""}
      </div>
      <div class="run-times">
        ${s.startedAt ? `<span>Started <strong>${esc(clock(s.startedAt))}</strong></span>` : ""}
        <span>Elapsed <strong>${esc(elapsed)}</strong></span>
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
        <dt>Stage</dt>
        <dd>${esc(label)}</dd>
      </div>
      <div>
        <dt>Rate</dt>
        <dd>${esc(rateLabel(processed, elapsedMs))}</dd>
      </div>
      <div>
        <dt>ETA</dt>
        <dd>${esc(etaLabel(processed, s.total, elapsedMs))}</dd>
      </div>
    </dl>

    ${mutedNote}
    ${s.lastError ? `<p class="err-line">${esc(s.lastError)}</p>` : ""}
  </section>`;
}

dashboard.get("/dashboard/fragment", async (c) => c.html(await progressPanel()));
dashboard.get("/dashboard/controls", (c) => c.html(controlsFragment()));
