export const TMP_DIR = ".Rclone-Extractor-tmp";

/** Prefix for app-owned run directories directly inside TMP_DIR. */
export const TMP_RUN_PREFIX = "run_";
/** Matches app-owned run directories inside TMP_DIR; everything else is left alone. */
export const TMP_RUN_DIR_RE = /^run_\d+$/;

export type TmpDirSpec =
  | { kind: "relative"; value: string } // resolved against the scan root
  | { kind: "absolute"; value: string }; // remote:path/to/tmp or /abs/local/tmp

/** True for `/abs/local/path` or `remote:path/to` (a remote name before the first slash, or a bare `remote:`). */
export function isAbsoluteTmpPath(raw: string): boolean {
  const s = raw.trim();
  if (s.startsWith("/")) return true;
  const colon = s.indexOf(":");
  if (colon === -1) return false;
  const slash = s.indexOf("/");
  return slash === -1 || colon < slash;
}

function norm(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Normalize and validate a user-supplied tmp_dir. Returns null when the value
 * is unusable (message-worthy) — callers should ask the user for a different
 * value. Empty input falls back to the default (callers treat "" as unset).
 */
export function parseTmpDir(
  raw: string,
  scanRoot: string,
  trashSubdir: string,
): TmpDirSpec | null {
  const trimmed = norm(raw);
  if (!trimmed) return null;
  if (trimmed === "/") return null;
  // "remote:" (bare remote) or "C:" (drive root): nothing to safely purge.
  if (trimmed.endsWith(":")) return null;
  if (trimmed.includes("..")) return null;
  if (trimmed.includes("\0")) return null;

  const absolute = isAbsoluteTmpPath(trimmed);
  if (!absolute && !/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;

  const scan = norm(scanRoot);
  const trash = norm(trashSubdir);
  const trashFull = scan && trash ? `${scan}/${trash}` : trash;
  const absTmp = absolute ? trimmed : scan ? `${scan}/${trimmed}` : trimmed;

  const overlaps = (a: string, b: string): boolean =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

  // A temp dir that coincides with the scan root or the trash dir (or the
  // scan-root/trash combo) would let the sweeper eat archives or trashed
  // files. Refuse those; anything nested under trash is also refused.
  if (scan && trimmed === scan) return null;
  if (trash && trimmed === trash) return null;
  if (scan && trash && trimmed === `${scan}/${trash}`) return null;
  if (trash && trimmed.startsWith(`${trash}/`)) return null;
  if (trash && trash.startsWith(`${trimmed}/`)) return null;
  // Absolute temp dirs get no promote exclusion from overlapping the scan
  // tree, so they may not overlap scan/trash at all (not even as a parent).
  if (absolute) {
    if (scan && overlaps(absTmp, scan)) return null;
    if (trashFull && overlaps(absTmp, trashFull)) return null;
  } else if (trashFull && overlaps(absTmp, trashFull)) {
    return null;
  }

  if (absolute) return { kind: "absolute", value: trimmed };

  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
  }
  return { kind: "relative", value: trimmed };
}

/** Top-level path where temporary extractions live, as passed to rclone. */
export function tmpRootPath(root: string, spec: TmpDirSpec): string {
  if (spec.kind === "absolute") return spec.value;
  return root ? `${root}/${spec.value}` : spec.value;
}

/** First segment of a relative tmp dir (used for the overlap exclusion in promote). */
export function tmpTopSegment(spec: TmpDirSpec): string | null {
  if (spec.kind === "absolute") return null;
  const idx = spec.value.indexOf("/");
  return idx === -1 ? spec.value : spec.value.slice(0, idx);
}

/** Directory holding all in-flight extraction data for one run. */
export function tmpRunDir(tmpRoot: string, runId: number): string {
  return `${tmpRoot}/${TMP_RUN_PREFIX}${runId}`;
}
export function tmpArchiveDir(tmpRoot: string, runId: number, archiveId: number): string {
  return `${tmpRunDir(tmpRoot, runId)}/${archiveId}`;
}
export function tmpStemDir(
  tmpRoot: string,
  runId: number,
  archiveId: number,
  stem: string,
): string {
  return `${tmpArchiveDir(tmpRoot, runId, archiveId)}/${stem}`;
}

export type SweepResult = {
  /** Direct children matching the app layout that were (or, in dry-run, would be) purged. */
  purged: string[];
  /** Non-app-looking entries left untouched. */
  skipped: string[];
  /** App-pattern entries whose purge failed. */
  failed: string[];
};
