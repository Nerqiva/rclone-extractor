import { baseNameOf } from "./domain";

/** Default trash subdirectory (override with the trash_subdir setting). */
export const TRASH = ".Trash";

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
// RcloneX (Nerqiva/rclonex) adds these to `archive extract`; upstream rclone
// does not know them. Only honored when the rclonex setting is enabled.
const RCLONEX_SUPPORTED = [".rar", ".7z", ".iso"];

export type MultiVolume = { kind: "rar" | "7z"; index: number };

/**
 * Detect a multivolume archive name (case-insensitive):
 *   rar: x.partN.rar (any zero padding), old-style x.r00..x.r99 (never first)
 *   7z:  x.7z.NNN    (split 7z volumes)
 * The first volume of a set (part1.rar, .7z.001) is queueable; every other
 * volume is not.
 */
export function multiVolumePart(name: string): MultiVolume | null {
  const lower = name.toLowerCase();
  let m = /^(.*)\.part(\d+)\.rar$/.exec(lower);
  if (m) return { kind: "rar", index: Number(m[2]) };
  m = /^(.*)\.7z\.(\d{3})$/.exec(lower);
  if (m) return { kind: "7z", index: Number(m[2]) };
  m = /^(.*)\.r(\d{2})$/.exec(lower);
  if (m) return { kind: "rar", index: 100 + Number(m[2]) };
  return null;
}

/** True for formats only rclonex can extract (first multivolume part only). */
export function isRclonexFormat(name: string): boolean {
  const lower = name.toLowerCase();
  const mv = multiVolumePart(lower);
  if (mv) {
    return mv.index === 1;
  }
  return RCLONEX_SUPPORTED.some((suffix) => lower.endsWith(suffix));
}

export function isSupported(name: string, rclonex = false): boolean {
  const lower = name.toLowerCase();
  if (SUPPORTED.some((suffix) => lower.endsWith(suffix))) return true;
  if (!rclonex) return false;
  return isRclonexFormat(name);
}

/**
 * Glob patterns for `rclone lsf --include` matching the names
 * {@link isSupported} accepts (case-insensitively, with --ignore-case).
 * Multivolume volumes are matched broadly (`.7z.NNN`; `.partN.rar` via
 * `*.rar`) because globs cannot express "zero or more padding then 1";
 * first-volume selection stays in-app. Old-style `.rNN` volumes are not
 * queueable at all, so no pattern is emitted for them.
 */
export function archiveIncludePatterns(rclonex = false): string[] {
  const patterns = SUPPORTED.map((suffix) => `*${suffix}`);
  if (rclonex) {
    patterns.push("*.rar", "*.7z", "*.7z.[0-9][0-9][0-9]", "*.iso");
  }
  return patterns;
}

const STEM_SUFFIXES = [...SUPPORTED, ...RCLONEX_SUPPORTED];

// Canonical grouping for the archive families the per-directory rule keys on.
// Aliases of one format share one key (.tgz is .tar.gz), so a directory
// holding a mix of alias names still counts as one type. RcloneX-handled
// formats map to null: they never enter the pre-inspection path this rule
// optimizes. Multivolume markers are not in the map either, so multivolume
// names return null by design.
const FAMILY_BY_SUFFIX: Record<string, string> = {
  ".zip": "zip",
  ".tar": "tar",
  ".tar.gz": "tar.gz",
  ".tgz": "tar.gz",
  ".taz": "taz",
  ".tar.bz2": "tar.bz2",
  ".tbz2": "tar.bz2",
  ".tbz": "tar.bz2",
  ".tb2": "tar.bz2",
  ".tz2": "tar.bz2",
  ".tar.lz": "tar.lz",
  ".tar.lz4": "tar.lz4",
  ".tar.xz": "tar.xz",
  ".txz": "tar.xz",
  ".tar.zst": "tar.zst",
  ".tzst": "tar.zst",
  ".tar.br": "tar.br",
  ".tar.sz": "tar.sz",
  ".tar.mz": "tar.mz",
};

/**
 * Canonical archive family of a base file name, or null when the name is not
 * a supported rclone-handled archive. Only the single-archive suffix the
 * name actually ends with is considered.
 */
export function archiveFamily(base: string): string | null {
  const lower = base.toLowerCase();
  for (const suffix of STEM_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return FAMILY_BY_SUFFIX[suffix] ?? null;
    }
  }
  return null;
}

/** Stem used for filename similarity: base name minus the matched suffix. */
function stemForCompare(base: string): string {
  const lower = base.toLowerCase();
  for (const suffix of STEM_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return base.slice(0, base.length - suffix.length);
    }
  }
  return base;
}

// Skeleton with everything except Unicode letters removed (digits go, so
// "vol01" and "vol2" both become "vol").
function skeleton(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}]/gu, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

const SIMILARITY_THRESHOLD = 0.8;

/**
 * Fuzzy filename match for archive collections. True when the two base names
 * reduce to the same digit-free skeleton (incremental/decremental series),
 * or the skeletons are Levenshtein-similar at or above 0.8. Plain unrelated
 * names ("a.zip" vs "b.zip") are not related.
 */
export function namesRelated(a: string, b: string): boolean {
  const sa = skeleton(stemForCompare(a));
  const sb = skeleton(stemForCompare(b));
  if (sa.length === 0 || sb.length === 0) {
    // Both empty: a pure counter series ("1.zip", "2.zip"). One empty and
    // one not: clearly different names.
    return sa.length === 0 && sb.length === 0;
  }
  if (sa === sb) return true;
  const dist = levenshtein(sa, sb);
  const maxLen = Math.max(sa.length, sb.length);
  return 1 - dist / maxLen >= SIMILARITY_THRESHOLD;
}
// Marker patterns to strip for multivolume stems, e.g. "x.part01.rar" -> "x".
const MV_MARKERS = [/\.part\d+\.rar$/i, /\.7z\.\d{3}$/i, /\.r\d{2}$/i];

/** Longest suffix of a base name that is a supported archive suffix (incl. multivolume). */
function stemSuffixOf(base: string): number {
  const lower = base.toLowerCase();
  for (const re of MV_MARKERS) {
    const m = re.exec(lower);
    if (m) return base.length - m.index;
  }
  for (const suffix of STEM_SUFFIXES) {
    if (lower.endsWith(suffix)) return suffix.length;
  }
  return 0;
}

export function stem(name: string): string {
  const base = baseNameOf(name);
  const suffix = stemSuffixOf(base);
  if (suffix > 0) {
    return sanitizeStem(base.slice(0, base.length - suffix));
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

const TINY_BYTES = 20 * 1024;
const SMALL_BYTES = 100 * 1024;

// Web development extensions commonly found in website dumps (HTTrack
// exports, static site builds). Deliberately excludes generic media and
// data formats (.png/.jpg/.json/.txt/.xml) to avoid misclassifying plain
// file collections. A dump is classified by DISTINCT extensions found
// anywhere in the archive (root and nested directories), not by file counts.
const WEBSITE_EXTS = [
  ".html",
  ".htm",
  ".xhtml",
  ".xhtm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".mjs",
  ".cjs",
  ".map",
  ".php",
  ".asp",
  ".aspx",
  ".jsp",
  ".vue",
  ".svelte",
  ".astro",
  ".woff",
  ".woff2",
  ".eot",
];
const WEBSITE_EXT_SET = new Set(WEBSITE_EXTS);

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
  // Backslashes and control chars: local backends may read "..\evil" as
  // traversal, and CR/LF would forge log rows.
  if (/[\\\x00-\x1f\x7f]/.test(t)) return false;
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
  /** Distinct recognized web-development extensions seen anywhere in the archive. */
  webExts: Set<string>;
};

export function createArchiveStats(): ArchiveStats {
  return { total: 0, torrent: 0, tiny: 0, small: 0, webExts: new Set() };
}

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

export function addArchiveEntry(
  stats: ArchiveStats,
  path: string,
  size: number,
): void {
  const base = baseNameOf(path).toLowerCase();
  stats.total++;
  if (base.endsWith(".torrent")) stats.torrent++;
  if (size < TINY_BYTES) stats.tiny++;
  if (size < SMALL_BYTES) stats.small++;
  const ext = extOf(base);
  if (WEBSITE_EXT_SET.has(ext)) stats.webExts.add(ext);
}

/**
 * Classify an archive's contents against the skip rules. Directories are not
 * passed to `addArchiveEntry` (the engine lists with `--files-only`), and all
 * extension checks are case-insensitive. A website dump is two or more
 * DISTINCT recognized web-development extensions anywhere in the archive
 * (root or nested directories), regardless of file sizes.
 */
export function classifyArchive(stats: ArchiveStats): SkipReason | null {
  if (stats.total === 0) return "empty";
  if (stats.torrent / stats.total >= 0.6) return "torrent";
  if (stats.webExts.size >= 2) return "website";
  if (stats.tiny / stats.total >= 0.6) return "tiny";
  return null;
}

/** Human-readable counts for logs and error messages. */
export function describeArchiveStats(stats: ArchiveStats): string {
  return `${stats.total} file(s), ${stats.tiny} tiny (<20KB), ${stats.small} small (<100KB), ${stats.torrent} .torrent, ${stats.webExts.size} distinct web extension(s)`;
}
