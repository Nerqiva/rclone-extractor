/**
 * In-memory registry of in-flight archive-file downloads. Used to keep a
 * single archive-file download at a time across the app (concurrency 1), to
 * grey out every Download button while one streams, and to refuse deleting
 * an archive whose file is being streamed right now.
 *
 * The registry is per process and counts streams, not requests: a ranged
 * resume is one download. Single-user app, so a counter with a set of ids
 * is all that is needed — nothing is persisted.
 */

const activeCounts = new Map<number, number>();

/** Register an in-flight download for `id`; returns an idempotent unregister. */
export function registerDownload(id: number): () => void {
  activeCounts.set(id, (activeCounts.get(id) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (activeCounts.get(id) ?? 1) - 1;
    if (n <= 0) activeCounts.delete(id);
    else activeCounts.set(id, n);
  };
}

export function activeDownloadCount(): number {
  let total = 0;
  for (const n of activeCounts.values()) total += n;
  return total;
}

export function isArchiveDownloading(id: number): boolean {
  return (activeCounts.get(id) ?? 0) > 0;
}
