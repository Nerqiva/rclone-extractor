import { Hono } from "hono";
import { engineState } from "../engine";
import { esc } from "../ui";
import { controlsFragment } from "./actions";

export const dashboard = new Hono();

const R = 52;
const CIRC = 2 * Math.PI * R;

function stateClass(): string {
  if (engineState.stage === "error") return "is-error";
  if (engineState.stage === "finished" && !engineState.running) return "is-done";
  if (engineState.running) return "is-running";
  return "";
}

export function statusCard(): string {
  const total = engineState.total;
  const processed = engineState.done + engineState.failed + engineState.skipped;
  const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const offset = CIRC * (1 - pct / 100);
  const cls = stateClass();
  const current = engineState.currentRel || (engineState.running ? "…" : "idle");

  return `<div class="statuscard ${cls}">
  <svg class="ring" width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
    <circle class="track" cx="66" cy="66" r="${R}"></circle>
    <circle class="prog" cx="66" cy="66" r="${R}"
      stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
      transform="rotate(-90 66 66)"></circle>
    <text class="ring-text" x="66" y="66">${Math.round(pct)}%</text>
  </svg>
  <div class="status-body">
    <div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    <p class="stage">${esc(engineState.stage)}</p>
    <p class="current" title="${esc(engineState.currentRel)}">${esc(current)}</p>
    <div>
      <span class="pill ok">done ${engineState.done}</span>
      <span class="pill err">failed ${engineState.failed}</span>
      <span class="pill warn">skipped ${engineState.skipped}</span>
    </div>
    ${engineState.lastError ? `<p class="err-line">${esc(engineState.lastError)}</p>` : ""}
  </div>
</div>`;
}

dashboard.get("/dashboard/fragment", (c) => c.html(statusCard()));
dashboard.get("/dashboard/controls", (c) => c.html(controlsFragment()));
