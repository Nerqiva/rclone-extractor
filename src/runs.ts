/**
 * Resolve the effective outcome for a runs row. Rows written before the
 * `outcome` column existed have it NULL; those fall back to the legacy
 * `interrupted` flag, then to `finished` when the run has an end time.
 */
export function resolveOutcome(row: {
  outcome: string | null;
  interrupted: number | null;
  finished_at: string | null;
}): string {
  if (row.outcome && row.outcome !== "") return row.outcome;
  if (Number(row.interrupted ?? 0) === 1) return "killed";
  return row.finished_at ? "finished" : "";
}
