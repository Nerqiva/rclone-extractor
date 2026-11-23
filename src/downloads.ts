const activeCounts = new Map<number, number>();


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

export function tryRegisterDownload(id: number): (() => void) | null {
  if (activeDownloadCount() > 0) return null;
  return registerDownload(id);
}

export function activeDownloadCount(): number {
  let total = 0;
  for (const n of activeCounts.values()) total += n;
  return total;
}

export function isArchiveDownloading(id: number): boolean {
  return (activeCounts.get(id) ?? 0) > 0;
}
