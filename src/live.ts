import { engineState } from "./engine";
import type { LiveArchiveState } from "./archiverows";

/** Live per-job state for the run currently on screen, or undefined. */
export function liveArchiveStates(
  runId: number,
  isLive: boolean,
): Map<number, LiveArchiveState> | undefined {
  if (!isLive || !engineState.running || engineState.runId !== runId) return undefined;
  return new Map(
    [...engineState.jobs.values()].map((job) => [
      job.id,
      { phase: job.phase, status: job.status, stats: job.stats },
    ]),
  );
}
