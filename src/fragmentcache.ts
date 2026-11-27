/**
 * Reuse a rendered fragment while its underlying rows are unchanged.
 * Poll endpoints call this on every tick; the fingerprint query is cheap and
 * avoids rebuilding hundreds of cards on an unchanged run.
 */
type Cached = { fingerprint: string; html: string };

const cache = new Map<string, Cached>();
const MAX_ENTRIES = 8;

export async function cachedFragment(
  key: string,
  fingerprint: () => Promise<string>,
  build: () => Promise<string>,
): Promise<string> {
  const current = await fingerprint();
  const hit = cache.get(key);
  if (hit && hit.fingerprint === current) return hit.html;
  const html = await build();
  cache.set(key, { fingerprint: current, html });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return html;
}
