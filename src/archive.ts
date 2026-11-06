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
    if (lower.endsWith(suffix)) return base.slice(0, base.length - suffix.length);
  }
  return base;
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
