import { esc } from "./ui";

export interface ErrorRow {
  id: number | string;
  path: string;
  error_kind: string;
  updated_at: string;
}

export function renderErrorRows(rows: ErrorRow[]): string {
  if (rows.length === 0) {
    return `<tr><td colspan="4" class="muted">No errors.</td></tr>`;
  }
  return rows
    .map(
      (r) => `<tr>
      <td class="path">${esc(r.path)}</td>
      <td><span class="pill warn">${esc(r.error_kind)}</span></td>
      <td class="muted">${esc(r.updated_at)}</td>
      <td class="nowrap">
        <button class="btn small" data-copy-url="/download/archive/${r.id}?kind=extract"
          title="Copy the full error log (extract output + command)" aria-label="Copy error log for ${esc(r.path)}">Copy</button>
        <a class="btn small ghost" href="/download/archive/${r.id}?kind=extract" aria-label="Download error log for ${esc(r.path)}">Download</a>
      </td>
    </tr>`,
    )
    .join("");
}

export async function readErrorRows(
  store: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
): Promise<ErrorRow[]> {
  return store.query<ErrorRow>(
    "SELECT id, path, error_kind, updated_at FROM archives WHERE error_kind IS NOT NULL ORDER BY updated_at DESC",
  );
}
