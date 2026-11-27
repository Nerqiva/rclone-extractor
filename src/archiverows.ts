import { store } from "./db";
import { esc } from "./ui";
import { emptyState, indeterminateBar, logActions, minibar, pill, retryBadge, statusBadge } from "./cardui";
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

export function renderArchiveLogRows(
  rows: ArchiveLogRow[],
  jobs?: Map<number, LiveArchiveState>,
): string {
  if (rows.length === 0) return emptyState("<p>No archives processed yet.</p>");
  const cards = rows
    .map((r) => {
      const id = Number(r.id);
      const idAttr = encodeURIComponent(String(id));
      const name = baseNameOf(r.path) || r.path;
      const [pillCls, basePill] = PILL[r.status] ?? ["", r.status];
      const pillMarkup = r.error_kind
        ? pill(r.error_kind, pillCls || "err")
        : pill(basePill, pillCls);
      const live = jobs?.get(id);
      const phase =
        live && live.status === "active" && live.phase
          ? statusBadge(live.phase, "is-running")
          : "";
      const st = live?.stats;
      const bar = st
        ? minibar(name, st.percent)
        : live?.status === "active"
          ? indeterminateBar(name, live.phase || "working")
          : "";
      const actions = logActions({
        id: idAttr,
        name,
        logId: `ar-log-${idAttr}`,
        copyHref: `/download/archive/${idAttr}?kind=extract`,
        downloadHref: `/download/archive/${idAttr}`,
        copyAria: `Copy log for ${esc(name)}`,
        downloadAria: `Download log for ${esc(name)}`,
      });
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          <span class="queue-id">Queue ID #${id}</span>
          ${phase}${pillMarkup}
          ${live ? retryBadge(live.attempt, live.cooldownUntil) : ""}
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        ${bar}
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))} · ${esc(formatBytes(Number(r.size)))}</span>
          <span class="error-actions">
            ${actions}
          </span>
        </div>
        <div class="pw-log log-viewer" id="ar-log-${idAttr}" hidden></div>
      </div>`;
    })
    .join("");
  return `<div class="error-grid">${cards}</div>`;
}
