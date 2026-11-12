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

function isRclonexSupported(lower: string): boolean {
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
  return isRclonexSupported(lower);
}

/**
 * Deterministic extractor selection. RcloneX is used only for the formats
 * listed above (including multivolume archives) when enabled; everything
 * else goes through rclone's native archive command.
 */
export function selectExtractor(
  name: string,
  rclonexEnabled: boolean,
): "rclone" | "rclonex" {
  if (!rclonexEnabled) return "rclone";
  const lower = name.toLowerCase();
  if (multiVolumePart(lower)) return "rclonex";
  if (RCLONEX_SUPPORTED.some((suffix) => lower.endsWith(suffix))) {
    return "rclonex";
  }
  return "rclone";
}

const STEM_SUFFIXES = [...SUPPORTED, ...RCLONEX_SUPPORTED];
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
  const base = name.slice(name.lastIndexOf("/") + 1);
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
  const base = baseName(path).toLowerCase();
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
