const SUPPORTED = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.lz4",
  ".tar.xz",
  ".tar.zst",
  ".tar.br",
  ".tar.sz",
  ".tar.mz",
  ".tar.lz",
  ".tgz",
  ".taz",
  ".tb2",
  ".tbz",
  ".tbz2",
  ".tz2",
  ".txz",
  ".tzst",
  ".zip",
  ".tar",
];

export function isSupported(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED.some((suffix) => lower.endsWith(suffix));
}

export function stem(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  for (const suffix of SUPPORTED) {
    if (lower.endsWith(suffix)) {
      const s = base.slice(0, base.length - suffix.length);
      return sanitizeStem(s);
    }
  }
  return sanitizeStem(base);
}

// The stem becomes a path segment passed to rclone. Collapse anything that
// could traverse or produce a degenerate directory name onto "x".
function sanitizeStem(s: string): string {
  const t = s.replace(/[\\/]/g, "_").replace(/\0/g, "").trim();
  if (!t || /^[.]+$/.test(t)) return "x";
  return t;
}

export function parentRel(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

export function tmpRel(rel: string, runId: number, archiveId: number): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return `.rclone-extractor-tmp/${runId}/${archiveId}/${stem(name)}`;
}

export function trashRel(rel: string, subdir: string): string {
  return `${subdir}/${rel}`;
}

const TINY_BYTES = 20 * 1024;
const SMALL_BYTES = 100 * 1024;

const WEBSITE_EXTS = [
  ".html",
  ".htm",
  ".xhtm",
  ".xhtml",
  ".css",
  ".js",
  ".woff",
  ".woff2",
  ".eot",
];
const WEBSITE_NAMES = new Set(["robots.txt", "index.html", "sitemap.xml"]);

/** Normalize a relative path the same way for trash checks and SQL LIKE prefixes. */
export function normalizeRel(p: string): string {
  return p
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * True for paths that are safe to pass to rclone under `<root>/<rel>`:
 * non-empty, not absolute, no `.`/`..`/empty segments. Anything from a
 * remote listing must pass this before it reaches extract/trash/promote.
 */
export function isSafeRel(p: string): boolean {
  if (typeof p !== "string") return false;
  const t = p.trim();
  if (!t || t.length > 4096 || t.includes("\0")) return false;
  if (t.startsWith("/") || /^[A-Za-z]:[\\/]/.test(t)) return false;
  for (const seg of t.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * Validate a trash subdir setting: relative, safe segments, non-empty.
 * Returns the normalized value, or null when unusable.
 */
export function parseTrashSubdir(raw: string): string | null {
  const t = normalizeRel(String(raw ?? "").trim());
  if (!t || t.length > 256 || t.includes("\0")) return null;
  for (const seg of t.split("/")) {
    if (!/^[A-Za-z0-9._-]+$/.test(seg) || seg === "." || seg === "..") {
      return null;
    }
  }
  return t;
}

function baseName(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Escape `\`, `%`, and `_` so `value` can be used inside a SQL LIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * True when `rel` lives inside the trash subdir. The trash root is the
 * top-level `<trash_subdir>/` under scan_root, so `trashy/x.zip` and
 * `a/trash/x.zip` are not excluded, while `trash/x.zip` is.
 */
export function isTrashPath(rel: string, trashSubdir: string): boolean {
  const trash = normalizeRel(trashSubdir);
  if (!trash) return false;
  const p = normalizeRel(rel);
  return p === trash || p.startsWith(`${trash}/`);
}

export type SkipReason = "empty" | "torrent" | "website" | "tiny";

export type ArchiveStats = {
  total: number;
  torrent: number;
  tiny: number;
  small: number;
  website: number;
};

export function createArchiveStats(): ArchiveStats {
  return { total: 0, torrent: 0, tiny: 0, small: 0, website: 0 };
}

export function addArchiveEntry(
  stats: ArchiveStats,
  path: string,
  size: number,
): void {
  const base = baseName(path).toLowerCase();
  stats.total++;
  if (base.endsWith(".torrent")) stats.torrent++;
  if (size < TINY_BYTES) stats.tiny++;
  if (size < SMALL_BYTES) stats.small++;
  if (WEBSITE_NAMES.has(base) || WEBSITE_EXTS.some((ext) => base.endsWith(ext))) {
    stats.website++;
  }
}

/**
 * Classify an archive's contents against the skip rules. Directories are not
 * passed to `addArchiveEntry` (the engine lists with `--files-only`), and all
 * extension/name checks are case-insensitive.
 */
export function classifyArchive(stats: ArchiveStats): SkipReason | null {
  if (stats.total === 0) return "empty";
  if (stats.torrent / stats.total >= 0.6) return "torrent";
  if (stats.website > 0 && stats.small / stats.total >= 0.2) {
    return "website";
  }
  if (stats.tiny / stats.total >= 0.6) return "tiny";
  return null;
}

/** Human-readable counts for logs and error messages. */
export function describeArchiveStats(stats: ArchiveStats): string {
  return `${stats.total} file(s), ${stats.tiny} tiny (<20KB), ${stats.small} small (<100KB), ${stats.torrent} .torrent, ${stats.website} website marker(s)`;
}
