import { esc } from "./ui";

export interface ErrorRow {
  id: number | string;
  path: string;
  error_kind: string;
  updated_at: string;
}

const KIND_CLASS: Record<string, string> = {
  password: "warn",
  empty: "warn",
  torrent: "warn",
  website: "warn",
  tiny: "warn",
  unreadable: "warn",
  extract: "err",
  promote: "err",
  trash: "err",
  spawn: "err",
  interrupted: "warn",
  killed: "warn",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return iso;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function renderErrorCards(rows: ErrorRow[]): string {
  if (rows.length === 0) {
    return `<div class="empty-state"><p>No errors.</p></div>`;
  }
  return `<div class="error-grid">${rows
    .map((r) => {
      const cls = KIND_CLASS[r.error_kind] || "err";
      const name = r.path.split("/").pop() || r.path;
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          <span class="pill ${cls}">${esc(r.error_kind)}</span>
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${relativeTime(r.updated_at)}</span>
          <span class="error-actions">
            <button class="btn small" data-copy-url="/download/archive/${encodeURIComponent(String(r.id))}?kind=extract"
              title="Copy the full error log" aria-label="Copy error log for ${esc(name)}">Copy</button>
            <a class="btn small ghost" href="/download/archive/${encodeURIComponent(String(r.id))}?kind=extract"
              aria-label="Download error log for ${esc(name)}">Download</a>
          </span>
        </div>
      </div>`;
    })
    .join("")}</div>`;
}

export async function readErrorRows(
  store: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
): Promise<ErrorRow[]> {
  return store.query<ErrorRow>(
    "SELECT id, path, error_kind, updated_at FROM archives WHERE error_kind IS NOT NULL ORDER BY updated_at DESC LIMIT 500",
  );
}
