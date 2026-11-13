import { store } from "./db";
import { esc } from "./ui";
import { formatBytes } from "./format";
import { relativeTime } from "./errorrows";

/**
 * Password-protected archives (Errors page). Password archives are skipped
 * during runs (a warn is logged and the run moves on to the next archive), so
 * they can pile up here; this module renders the rows with their actions
 * (inline log view, download, move to trash / restore).
 */

export interface PasswordRow {
  id: number | string;
  path: string;
  size: number | string;
  status: string;
  updated_at: string;
}

export async function readPasswordRows(): Promise<PasswordRow[]> {
  return store.query<PasswordRow>(
    "SELECT id, path, size, status, updated_at FROM archives WHERE error_kind='password' ORDER BY updated_at DESC LIMIT 200",
  );
}

/** Render the outerHTML-swappable list container for the password section. */
export function renderPasswordList(rows: PasswordRow[]): string {
  if (rows.length === 0) {
    return `<div id="pw-list"><div class="empty-state"><p>No password-protected archives.</p></div></div>`;
  }
  const cards = rows
    .map((r) => {
      const id = Number(r.id);
      const name = r.path.split("/").pop() || r.path;
      const inTrash = r.status === "deleted";
      const pill = inTrash
        ? `<span class="pill">in trash</span>`
        : `<span class="pill warn">password</span>`;
      const idAttr = encodeURIComponent(String(id));
      const action = inTrash
        ? `<button class="btn small" hx-post="/archives/${idAttr}/restore" hx-target="#pw-list" hx-swap="outerHTML">Restore</button>`
        : `<button class="btn small danger" hx-post="/archives/${idAttr}/delete" hx-target="#pw-list" hx-swap="outerHTML" data-confirm="Move this archive to the trash folder?|Delete">Delete</button>`;
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          ${pill}
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))} · ${esc(formatBytes(Number(r.size)))}</span>
          <span class="error-actions">
            <button class="btn small" type="button" data-pw-log="${idAttr}" aria-expanded="false" aria-controls="pw-log-${idAttr}">Log view</button>
            <button class="btn small" type="button" data-copy-url="/download/archive/${idAttr}?kind=extract" title="Copy the archive log" aria-label="Copy log for ${esc(name)}">Copy log</button>
            <a class="btn small ghost" href="/download/archive-file/${idAttr}">Download</a>
            ${action}
          </span>
        </div>
        <div class="pw-log log-viewer" id="pw-log-${idAttr}" hidden></div>
      </div>`;
    })
    .join("");
  return `<div id="pw-list" class="error-grid">${cards}</div>`;
}
