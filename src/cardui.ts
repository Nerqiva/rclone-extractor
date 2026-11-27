import { MAX_RETRIES } from "./engine";
import { esc } from "./ui";

// Small server-rendered pieces shared by every archive card. Keeping the
// markup here stops the Errors, Logs, Progress and Password cards from
// drifting apart one edit at a time.
export function emptyState(inner: string): string {
  return `<div class="empty-state">${inner}</div>`;
}

export function pill(text: string, kind = ""): string {
  return `<span class="pill${kind ? ` ${kind}` : ""}">${esc(text)}</span>`;
}

export function statusBadge(label: string, cls: string): string {
  return `<span class="status-badge${cls ? ` ${cls}` : ""}"><span class="dot"></span>${esc(label)}</span>`;
}

export function stageBadge(stage: string): string {
  return `<span class="stage-badge">failed at ${esc(stage)}</span>`;
}

function ordinalOf(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function retryBadge(attempt: number, cooldownUntil: number, withTitle = false): string {
  if (attempt <= 1) return "";
  const now = Date.now();
  const retryNo = attempt - 1;
  const ordinal = ordinalOf(retryNo);
  const retry = withTitle
    ? `<span class="retry-info" title="This command is on its ${ordinal} retry after ${MAX_RETRIES} max">retry ${retryNo}/${MAX_RETRIES}</span>`
    : `<span class="retry-info">retry ${retryNo}/${MAX_RETRIES}</span>`;
  const cooling = cooldownUntil > now
    ? `<span class="cooldown-info">cooldown ${Math.ceil((cooldownUntil - now) / 1000)}s</span>`
    : "";
  return retry + cooling;
}

export function minibar(name: string, percent: number | null): string {
  const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return `<div class="minibar" role="progressbar" aria-label="${esc(name)} transfer" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><span style="width:${pct.toFixed(1)}%"></span></div>`;
}

export function indeterminateBar(name: string, phase = ""): string {
  return `<div class="minibar is-indeterminate" role="progressbar" aria-label="${esc(name)} — ${esc(phase || "working")}"><span></span></div>`;
}

export interface LogActionsOptions {
  id: string;
  name: string;
  logId: string;
  copyHref: string;
  downloadHref: string;
  copyLabel?: string;
  copyTitle?: string;
  copyAria?: string;
  downloadAria?: string;
  downloadAttrs?: string;
}

export function logToggleButton(id: string, logId: string, ghost = false): string {
  return `<button class="btn small${ghost ? " ghost" : ""}" type="button" data-log-toggle="${id}" aria-expanded="false" aria-controls="${logId}">Log view</button>`;
}

export function logActions(o: LogActionsOptions): string {
  const copy = `<button class="btn small" type="button" data-copy-url="${o.copyHref}" title="${o.copyTitle || "Copy the archive log"}" aria-label="${o.copyAria || `Copy log for ${esc(o.name)}`}">${o.copyLabel || "Copy log"}</button>`;
  const downloadAttrs = o.downloadAttrs ? ` ${o.downloadAttrs}` : "";
  const downloadAria = o.downloadAria ? ` aria-label="${o.downloadAria}"` : "";
  const download = `<a class="btn small ghost" href="${o.downloadHref}"${downloadAttrs}${downloadAria}>Download</a>`;
  return logToggleButton(o.id, o.logId) + copy + download;
}
