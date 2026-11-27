import { getSetting } from "./db";
import {
  parseTmpDir,
  TMP_DIR,
  type TmpDirSpec,
} from "./tmpdir";
import { TRASH } from "./archive";

export type TmpDirSettings = {
  scanRoot: string;
  spec: TmpDirSpec | null;
  raw: string;
};

export async function loadTmpDirSettings(
  trashSubdir?: string,
  settings?: Record<string, string>,
): Promise<TmpDirSettings> {
  const scanRoot = settings?.["scan_root"] ?? ((await getSetting("scan_root", "")) ?? "");
  const trash =
    trashSubdir ??
    settings?.["trash_subdir"] ??
    ((await getSetting("trash_subdir", TRASH)) ?? TRASH);
  const raw = (settings?.["tmp_dir"] ?? ((await getSetting("tmp_dir", TMP_DIR)) ?? TMP_DIR)).trim();
  const spec = raw
    ? parseTmpDir(raw, scanRoot, trash)
    : { kind: "relative" as const, value: TMP_DIR };
  return { scanRoot, spec, raw };
}
