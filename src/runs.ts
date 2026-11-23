import { store } from "./db";

export const STALE_MS = 10 * 60 * 1000;

export async function liveRunIds(): Promise<Set<number>> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const rows = await store.query<{ id: number | string }>(
    "SELECT id FROM runs WHERE finished_at IS NULL AND COALESCE(last_touch_at, started_at) >= ?",
    [cutoff],
  );
  return new Set(rows.map((r) => Number(r.id)));
}


export function resolveOutcome(row: {
  outcome: string | null;
  interrupted: number | null;
  finished_at: string | null;
}): string {
  if (row.outcome && row.outcome !== "") return row.outcome;
  if (Number(row.interrupted ?? 0) === 1) return "killed";
  return row.finished_at ? "finished" : "";
}
