import { getSetting } from "./db";
import {
  parseTmpDir,
  TMP_DIR_DEFAULT,
  type TmpDirSpec,
} from "./tmpdir";

export type TmpDirSettings = {
  /** Effective dry_run flag. */
  dryRun: boolean;
  /** Configured scan root (unvalidated here; callers check for the empty case). */
  scanRoot: string;
  /** Parsed tmp_dir; null when the configured value is unusable. */
  spec: TmpDirSpec | null;
  /** Raw (trimmed) tmp_dir value, for error messages. */
  raw: string;
};

/**
 * Read the tmp_dir-related settings and parse them the same way everywhere
 * (boot sweep, maintenance purge, engine run). `trashSubdir` may be passed
 * pre-validated (engine); otherwise the raw setting is used, matching how
 * parseTmpDir consumed it before this helper existed.
 */
export async function loadTmpDirSettings(
  trashSubdir?: string,
): Promise<TmpDirSettings> {
  const dryRun = (await getSetting("dry_run", "0")) === "1";
  const scanRoot = (await getSetting("scan_root", "")) ?? "";
  const trash =
    trashSubdir ?? ((await getSetting("trash_subdir", "trash")) ?? "trash");
  const raw =
    ((await getSetting("tmp_dir", TMP_DIR_DEFAULT)) ?? TMP_DIR_DEFAULT).trim();
  const spec = raw
    ? parseTmpDir(raw, scanRoot, trash)
    : { kind: "relative" as const, value: TMP_DIR_DEFAULT };
  return { dryRun, scanRoot, spec, raw };
}
