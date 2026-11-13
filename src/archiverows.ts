import { store } from "./db";
import { esc } from "./ui";
import { formatBytes } from "./format";
import { relativeTime } from "./errorrows";

/**
 * Per-run archive log listing (Logs page, "Archives" tab). Every archive a
 * run processed — done, failed, skipped, or still in progress — gets a card
 * with its raw rclone output one tap away. Passwords stay on the Errors
 * tab; nothing here moves files.
 */

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

export function renderArchiveLogRows(rows: ArchiveLogRow[]): string {
  if (rows.length === 0) {
    return `<div class="empty-state"><p>No archives processed yet.</p></div>`;
  }
  const cards = rows
    .map((r) => {
      const id = Number(r.id);
      const idAttr = encodeURIComponent(String(id));
      const name = r.path.split("/").pop() || r.path;
      const [pillCls, basePill] = PILL[r.status] ?? ["", r.status];
      const pill = r.error_kind
        ? `<span class="pill ${pillCls || "err"}">${esc(r.error_kind)}</span>`
        : `<span class="pill ${pillCls}">${esc(basePill)}</span>`;
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          ${pill}
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
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
