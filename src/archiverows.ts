import { store } from "./db";
import { MAX_RETRIES } from "./engine";
import { esc } from "./ui";
import { formatBytes } from "./format";
import { baseNameOf } from "./domain";
import { relativeTime } from "./errorrows";
import type { ExtractStats } from "./rclone";

export interface LiveArchiveState {
  phase: string;
  status: string;
  stats: ExtractStats | null;
  attempt: number;
  cooldownUntil: number;
}


export interface ArchiveLogRow {
  id: number | string;
  path: string;
  size: number | string;
  status: string;
  error_kind: string | null;
  updated_at: string;
}

export async function readArchiveLogRows(runId: number): Promise<ArchiveLogRow[]> {
  return store.query<ArchiveLogRow>(
    "SELECT id, path, size, status, error_kind, updated_at FROM archives WHERE last_run_id = ? ORDER BY updated_at ASC, id ASC LIMIT 500",
    [runId],
  );
}

const PILL: Record<string, [string, string]> = {
  done: ["ok", "done"],
  failed: ["err", "failed"],
  skipped: ["warn", "skipped"],
  extracting: ["warn", "extracting"],
  deleted: ["", "in trash"],
  queued: ["", "queued"],
};

function retryBadge(attempt: number, cooldownUntil: number): string {
  if (attempt <= 1) return "";
  const now = Date.now();
  const retry = `<span class="retry-info">retry ${attempt - 1}/${MAX_RETRIES}</span>`;
  const cooling = cooldownUntil > now
    ? `<span class="cooldown-info">cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s</span>`
    : "";
  return retry + cooling;
}

export function renderArchiveLogRows(
  rows: ArchiveLogRow[],
  jobs?: Map<number, LiveArchiveState>,
): string {
  if (rows.length === 0) {
    return `<div class="empty-state"><p>No archives processed yet.</p></div>`;
  }
  const cards = rows
    .map((r) => {
      const id = Number(r.id);
      const idAttr = encodeURIComponent(String(id));
      const name = baseNameOf(r.path) || r.path;
      const [pillCls, basePill] = PILL[r.status] ?? ["", r.status];
      const pill = r.error_kind
        ? `<span class="pill ${pillCls || "err"}">${esc(r.error_kind)}</span>`
        : `<span class="pill ${pillCls}">${esc(basePill)}</span>`;
      const live = jobs?.get(id);
      const phase =
        live && live.status === "active" && live.phase
          ? `<span class="status-badge is-running"><span class="dot"></span>${esc(live.phase)}</span>`
          : "";
      const st = live?.stats;
      const bar = st
        ? (() => {
            const pct = st.percent === null ? 0 : Math.max(0, Math.min(100, st.percent));
            return `<div class="minibar" role="progressbar" aria-label="${esc(name)} transfer" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
          })()
        : live?.status === "active"
          ? `<div class="minibar is-indeterminate" role="progressbar" aria-label="${esc(name)} — ${esc(live.phase || "working")}"><span></span></div>`
          : "";
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          <span class="queue-id">Queue ID #${id}</span>
          ${phase}${pill}
          ${live ? retryBadge(live.attempt, live.cooldownUntil) : ""}
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        ${bar}
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))} · ${esc(formatBytes(Number(r.size)))}</span>
          <span class="error-actions">
            <button class="btn small" type="button" data-log-toggle="${idAttr}" aria-expanded="false" aria-controls="ar-log-${idAttr}">Log view</button>
            <button class="btn small" type="button" data-copy-url="/download/archive/${idAttr}?kind=extract" title="Copy the archive log" aria-label="Copy log for ${esc(name)}">Copy log</button>
            <a class="btn small ghost" href="/download/archive/${idAttr}" aria-label="Download log for ${esc(name)}">Download</a>
          </span>
        </div>
        <div class="pw-log log-viewer" id="ar-log-${idAttr}" hidden></div>
      </div>`;
    })
    .join("");
  return `<div class="error-grid">${cards}</div>`;
}
