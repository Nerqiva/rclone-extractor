import { esc, info } from "./ui";
import { baseNameOf } from "./domain";
import { COMMAND_SEPARATOR, stageOf } from "./log";

export interface ErrorRow {
  id: number | string;
  path: string;
  error_kind: string;
  updated_at: string;
  message: string;
  stage: string;
}

const APP_LINE = /^(?:skipped \(|killed:|recovered:|archive error:|listing failed|command failed with exit|post-extraction listing failed)/;

// The error kind names the phase that failed; use it to find that command's
// output even when a later cleanup command also wrote lines to the log.
const KIND_COMMAND: Record<string, RegExp> = {
  extract: /\sarchive extract\b/,
  promote: /\smove\b/,
  trash: /\smoveto\b/,
  unreadable: /\sarchive list\b/,
};

// Skips are recorded with an error_kind too, but they need no action. Keep
// them out of the failure cards so the Errors page is a work queue.
const INFO_KINDS = new Set([
  "empty",
  "torrent",
  "website",
  "tiny",
  "unreadable",
  "skip_requested",
]);

export function isInformationalKind(kind: string): boolean {
  return INFO_KINDS.has(kind);
}

const KIND_CLASS: Record<string, string> = {
  password: "warn",
  empty: "info",
  torrent: "info",
  website: "info",
  tiny: "info",
  unreadable: "info",
  skip_requested: "info",
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

function errorCard(r: ErrorRow): string {
  const cls = KIND_CLASS[r.error_kind] || "err";
  const name = baseNameOf(r.path) || r.path;
  const idAttr = encodeURIComponent(String(r.id));
  const stage = r.stage
    ? `<span class="stage-badge">failed at ${esc(r.stage)}</span>`
    : "";
  return `<div class="error-card">
        <div class="error-card-head">
          <span class="error-name" title="${esc(r.path)}">${esc(name)}</span>
          <span class="queue-id">Queue ID #${r.id}</span>
          ${stage}<span class="pill ${cls}">${esc(r.error_kind)}</span>
        </div>
        <div class="error-path muted">${esc(r.path)}</div>
        ${r.message ? `<pre class="error-message">${esc(r.message)}</pre>` : ""}
        <div class="error-card-foot">
          <span class="muted" title="${esc(r.updated_at)}">${esc(relativeTime(r.updated_at))}</span>
          <span class="error-actions">
            <button class="btn small" type="button" data-log-toggle="${idAttr}" aria-expanded="false" aria-controls="er-log-${idAttr}">Log view</button>
            <button class="btn small" data-copy-url="/download/archive/${idAttr}?kind=extract"
              title="Copy the full error log" aria-label="Copy error log for ${esc(name)}">Copy</button>
            <a class="btn small ghost" href="/download/archive/${idAttr}?kind=extract"
              aria-label="Download error log for ${esc(name)}">Download</a>
          </span>
        </div>
        <div class="pw-log log-viewer" id="er-log-${idAttr}" hidden></div>
      </div>`;
}

export function renderFailureCards(rows: ErrorRow[]): string {
  const failures = rows.filter((r) => !isInformationalKind(r.error_kind));
  return failures.length
    ? `<div class="error-grid">${failures.map(errorCard).join("")}</div>`
    : `<div class="empty-state"><p>No failed archives.</p></div>`;
}

export function renderSkipCards(rows: ErrorRow[]): string {
  const skips = rows.filter((r) => isInformationalKind(r.error_kind));
  return skips.length
    ? `<div class="error-grid">${skips.map(errorCard).join("")}</div>`
    : "";
}

export function renderErrorCards(rows: ErrorRow[]): string {
  const failures = renderFailureCards(rows);
  const skips = renderSkipCards(rows);
  return `${failures}${
    skips
      ? `<h3 class="error-group-title">Informational skips ${info(
          "Archives intentionally skipped by the skip rules (tiny, website dump, torrent collection, unreadable). No action needed.",
          "Informational skips",
        )}</h3>${skips}`
      : ""
  }`;
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
    [...ids, ids.length * 60],
  );
  const byId = new Map<number, string[]>();
  for (const entry of lines) {
    if (APP_LINE.test(entry.line) || entry.line === COMMAND_SEPARATOR) continue;
    const id = Number(entry.ref_id);
    const kept = byId.get(id) ?? [];
    kept.push(entry.line);
    byId.set(id, kept);
  }
  return rows.map((r) => {
    const chronological = (byId.get(Number(r.id)) ?? []).reverse();
    const groups: { command: string; output: string[] }[] = [];
    for (const line of chronological) {
      if (line.startsWith("$ ")) groups.push({ command: line, output: [] });
      else if (groups.length > 0) groups[groups.length - 1].output.push(line);
    }
    // Logs written before command markers have no groups; show the raw tail.
    if (groups.length === 0) {
      return {
        ...r,
        message: chronological.slice(-8).join("\n"),
        stage: chronological.map(stageOf).filter(Boolean).pop() ?? "",
      };
    }
    const newestFirst = [...groups].reverse();
    const wanted = KIND_COMMAND[r.error_kind];
    const group =
      (wanted ? newestFirst.find((g) => wanted.test(g.command)) : undefined) ??
      newestFirst.find((g) => g.output.length > 0) ??
      newestFirst[0];
    return {
      ...r,
      message: [group.command, ...group.output.slice(-8)].filter(Boolean).join("\n"),
      stage: stageOf(group.command),
    };
  });
}
