/** Shared, pure vocabulary for paths and status labels. No DB or app state. */

export function baseNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Directory part of a relative archive path ("" for scan-root archives). */
export function dirOfRel(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

const STAGE_LABEL: Record<string, string> = {
  idle: "Idle",
  listing: "Listing archives",
  queueing: "Building queue",
  extracting: "Extracting",
  finished: "Completed",
  interrupted: "Interrupted",
  killed: "Killed",
  error: "Error",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export function stateClass(stage: string, running: boolean): string {
  if (stage === "error") return "is-error";
  if (stage === "killed") return "is-killed";
  if (stage === "interrupted") return "is-interrupted";
  if (running) return "is-running";
  if (stage === "finished") return "is-done";
  return "is-idle";
}

export function jobStatusClass(status: string): string {
  if (status === "done") return "is-done";
  if (status === "failed") return "is-error";
  if (status === "skipped") return "is-interrupted";
  if (status === "active") return "is-running";
  return "";
}

export function jobPillClass(status: string): string {
  if (status === "done") return "ok";
  if (status === "failed") return "err";
  if (status === "skipped") return "warn";
  return "";
}

/** Parse an external id at the route boundary. Rejects 0, negatives and junk. */
export function positiveId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
