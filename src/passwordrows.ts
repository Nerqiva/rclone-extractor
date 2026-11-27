import { store } from "./db";
import { esc } from "./ui";
import { emptyState, logActions, pill, stageBadge } from "./cardui";
import { formatBytes } from "./format";
import { baseNameOf } from "./domain";
import { relativeTime } from "./errorrows";
import { stageOf } from "./log";
import { engineState } from "./engine";


export interface PasswordRow {
  id: number | string;
  path: string;
  size: number | string;
  status: string;
  updated_at: string;
  stage: string;
}

export async function readPasswordRows(): Promise<PasswordRow[]> {
  const rows = await store.query<Omit<PasswordRow, "stage">>(
    "SELECT id, path, size, status, updated_at FROM archives WHERE error_kind='password' ORDER BY updated_at DESC LIMIT 200",
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => "?").join(", ");
  const lines = await store.query<{ ref_id: number; line: string }>(
    `SELECT ref_id, line FROM log_lines WHERE scope='archive' AND kind='extract' AND ref_id IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    [...ids, ids.length * 80],
  );
  const stages = new Map<number, string>();
  for (const entry of lines) {
    const stage = stageOf(entry.line);
    if (stage && !stages.has(Number(entry.ref_id))) stages.set(Number(entry.ref_id), stage);
  }
  return rows.map((r) => ({ ...r, stage: stages.get(Number(r.id)) ?? "" }));
}

/** Render the outerHTML-swappable list container for the password section. */
export function renderPasswordList(rows: PasswordRow[]): string {
  if (rows.length === 0) {
    return `<div id="pw-list">${emptyState("<p>No password-protected archives.</p>")}</div>`;
  }
  const cards = rows
    .map((r) => {
      const id = Number(r.id);
      const name = baseNameOf(r.path) || r.path;
      const inTrash = r.status === "deleted";
      const pending = engineState.deferredPasswordMoves.some((m) => m.id === id);
      const pillMarkup = pending
        ? pill("pending", "warn")
        : inTrash
          ? pill("in trash")
          : pill("password", "warn");
      const idAttr = encodeURIComponent(String(id));
      const disabled = pending ? " disabled" : "";
      const action = inTrash
        ? `<button class="btn small"${disabled} hx-post="/archives/${idAttr}/restore" hx-target="#pw-list" hx-swap="outerHTML">Restore</button>`
        : `<button class="btn small danger"${disabled} hx-post="/archives/${idAttr}/delete" hx-target="#pw-list" hx-swap="outerHTML" data-confirm="Move this archive to the trash folder?|Delete">Delete</button>`;
      const actions = logActions({
        id: idAttr,
        name,
        logId: `pw-log-${idAttr}`,
        copyHref: `/download/archive/${idAttr}?kind=extract`,
        downloadHref: `/download/archive-file/${idAttr}`,
        copyAria: `Copy log for ${esc(name)}`,
        downloadAttrs: `data-download-archive data-archive-id="${idAttr}"`,
      }) + action;
      return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          <span class="queue-id">Queue ID #${id}</span>
          ${r.stage ? stageBadge(r.stage) : ""}
          ${pillMarkup}
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))} · ${esc(formatBytes(Number(r.size)))}</span>
          <span class="error-actions">
            ${actions}
          </span>
        </div>
        <div class="pw-log log-viewer" id="pw-log-${idAttr}" hidden></div>
      </div>`;
    })
    .join("");
  return `<div id="pw-list" class="error-grid">${cards}</div>`;
}
