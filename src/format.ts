/**
 * Shared human-readable formatters. One byte format and one duration
 * format, used by every page.
 */

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Byte count → "1.50 MiB" style. Non-finite or negative → "—". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${BYTE_UNITS[i]}`;
}

/** Bytes per second → "1.50 MiB/s". Null/non-finite → "—". */
export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Milliseconds → "1h 02m 03s" or "2m 05s". Non-finite/<=0 → `fallback`. */
export function formatDuration(ms: number, fallback = "—"): string {
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  }
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
