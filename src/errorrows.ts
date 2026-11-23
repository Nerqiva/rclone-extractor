import { esc } from "./ui";

export interface ErrorRow {
  id: number | string;
  path: string;
  error_kind: string;
  updated_at: string;
  message: string;
}

const APP_LINE = /^(?:\$|skipped \(|killed:|recovered:|archive error:|listing failed|command failed with exit|post-extraction listing failed)/;

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

export function relativeTime(iso: string): string {
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
        ${r.message ? `<pre class="error-message">${esc(r.message)}</pre>` : ""}
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))}</span>
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
  const rows = await store.query<Omit<ErrorRow, "message">>(
    "SELECT id, path, error_kind, updated_at FROM archives WHERE error_kind IS NOT NULL AND error_kind <> 'password' ORDER BY updated_at DESC LIMIT 500",
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => "?").join(", ");
  const lines = await store.query<{ ref_id: number; line: string }>(
    `SELECT ref_id, line FROM log_lines WHERE scope='archive' AND kind='extract' AND ref_id IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    [...ids, ids.length * 20],
  );
  const byId = new Map<number, string[]>();
  for (const entry of lines) {
    if (APP_LINE.test(entry.line)) continue;
    const kept = byId.get(Number(entry.ref_id)) ?? [];
    if (kept.length < 8) kept.push(entry.line);
    byId.set(Number(entry.ref_id), kept);
  }
  return rows.map((r) => ({
    ...r,
    message: (byId.get(Number(r.id)) ?? []).reverse().join("\n"),
  }));
}
