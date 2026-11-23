import { RCLONE_BIN, RCLONEX_BIN } from "./config";

/**
 * One row per user-editable extra-flags field. Readers, validation, the
 * migration and the form all walk this table, so a command cannot pick up
 * another command's flags by accident.
 */
export type ExtraFlagField = {
  key: string;
  label: string;
  binary: "rclone" | "rclonex";
  command: string;
  desc: string;
  /** Legacy remote_flags is copied here (only when the target is empty). */
  fromLegacyRemoteFlags?: boolean;
};

export const EXTRA_FLAG_FIELDS: readonly ExtraFlagField[] = [
  {
    key: "lsf_extra_flags",
    label: "Listing (lsf)",
    binary: "rclone",
    command: "lsf",
    desc: "Extra flags for rclone lsf (archive scan and temp-dir listing).",
  },
  {
    key: "archive_list_extra_flags",
    label: "Archive inspection (archive list)",
    binary: "rclone",
    command: "archive list",
    desc: "Extra flags for rclone archive list (pre-extraction inspection).",
  },
  {
    key: "extract_extra_flags",
    label: "Extraction (archive extract)",
    binary: "rclone",
    command: "archive extract",
    desc: "Extra flags for rclone archive extract.",
    fromLegacyRemoteFlags: true,
  },
  {
    key: "rclonex_extract_extra_flags",
    label: "RcloneX extraction (archive extract)",
    binary: "rclonex",
    command: "archive extract",
    desc: "Extra flags for rclonex archive extract. Password and window flags are configured separately.",
  },
  {
    key: "move_extra_flags",
    label: "Promotion (move)",
    binary: "rclone",
    command: "move",
    desc: "Extra flags for rclone move (promoting extracted files).",
    fromLegacyRemoteFlags: true,
  },
  {
    key: "moveto_extra_flags",
    label: "Move (moveto)",
    binary: "rclone",
    command: "moveto",
    desc: "Extra flags for rclone moveto (trash and Delete/Restore).",
  },
  {
    key: "cat_extra_flags",
    label: "Downloads (cat)",
    binary: "rclone",
    command: "cat",
    desc: "Extra flags for rclone cat (archive downloads).",
    fromLegacyRemoteFlags: true,
  },
  {
    key: "lsl_extra_flags",
    label: "Exists check (lsl)",
    binary: "rclone",
    command: "lsl",
    desc: "Extra flags for rclone lsl (overwrite checks).",
  },
  {
    key: "lsjson_extra_flags",
    label: "File stat (lsjson)",
    binary: "rclone",
    command: "lsjson",
    desc: "Extra flags for rclone lsjson (download size/mtime probe).",
  },
  {
    key: "purge_extra_flags",
    label: "Purge (purge)",
    binary: "rclone",
    command: "purge",
    desc: "Extra flags for rclone purge (temp cleanup).",
  },
  {
    key: "rmdir_extra_flags",
    label: "Remove directory (rmdir)",
    binary: "rclone",
    command: "rmdir",
    desc: "Extra flags for rclone rmdir (empty-directory cleanup).",
  },
] as const;

/** The settings key a runner reads for one of its commands. */
export function extraFlagKey(
  binary: "rclone" | "rclonex",
  command: string,
): string | undefined {
  return EXTRA_FLAG_FIELDS.find(
    (f) => f.binary === binary && f.command === command,
  )?.key;
}

/** Split a stored field into arguments. --config is never honored from a field. */
export function parseExtraFlags(raw: string): string[] {
  const out: string[] = [];
  const parts = raw.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--config") {
      i++; // drop its value too
      continue;
    }
    if (part.startsWith("--config=")) continue;
    out.push(part);
  }
  return out;
}

function flagNames(args: string[]): string[] {
  const names: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-" || arg === "--") continue;
    const name = arg.replace(/=.*$/, "");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const HELP_FLAG_RE = /--?[A-Za-z][A-Za-z0-9-]*/g;

function helpEnv(): Record<string, string> {
  const keep = [
    "PATH", "HOME", "TMPDIR", "TZ", "LANG",
    "SystemRoot", "SystemDrive", "USERPROFILE", "TEMP", "TMP",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("RCLONE_") && v !== undefined) out[k] = v;
  }
  return out;
}

const helpCache = new Map<string, Promise<Set<string> | null>>();

async function loadKnownFlags(
  binary: "rclone" | "rclonex",
  command: string,
): Promise<Set<string> | null> {
  const bin = binary === "rclonex" ? RCLONEX_BIN : RCLONE_BIN;
  const outputs: string[] = [];
  for (const args of [command.split(/\s+/).concat("--help"), ["help", "flags"]]) {
    try {
      const proc = Bun.spawn([bin, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: helpEnv(),
      });
      const killer = setTimeout(() => proc.kill(), 4000);
      try {
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited.catch(() => {});
        outputs.push(`${out}\n${err}`);
      } finally {
        clearTimeout(killer);
      }
    } catch {
      // A missing or unstartable binary must not block configuration.
    }
  }
  const names = new Set<string>();
  for (const text of outputs) {
    for (const m of text.matchAll(HELP_FLAG_RE)) names.add(m[0]);
  }
  return names.size > 0 ? names : null;
}

function knownFlags(
  binary: "rclone" | "rclonex",
  command: string,
): Promise<Set<string> | null> {
  const cacheKey = `${binary}\u0000${command}`;
  let pending = helpCache.get(cacheKey);
  if (!pending) {
    pending = loadKnownFlags(binary, command);
    helpCache.set(cacheKey, pending);
  }
  return pending;
}

export type FlagCheck =
  | { ok: true; warning?: string }
  | { ok: false; unknown: string[] };

/** Validate one field's flag names against the installed binary. */
export async function validateExtraFlags(
  field: ExtraFlagField,
  raw: string,
): Promise<FlagCheck> {
  const names = flagNames(parseExtraFlags(raw));
  if (names.length === 0) return { ok: true };
  const known = await knownFlags(field.binary, field.command);
  if (!known) {
    return {
      ok: true,
      warning: `could not read ${field.binary} ${field.command} help; ${field.key} saved without validation`,
    };
  }
  const unknown = names.filter((name) => !known.has(name));
  return unknown.length ? { ok: false, unknown } : { ok: true };
}

/**
 * Backstop for values that bypass the form (an old backup, a hand-edited DB).
 * One clear run error is raised upstream instead of failing every archive.
 */
export async function validateStoredExtraFlags(
  settings: Record<string, string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const field of EXTRA_FLAG_FIELDS) {
    const raw = settings[field.key] ?? "";
    if (!raw.trim()) continue;
    const check = await validateExtraFlags(field, raw);
    if (!check.ok) {
      problems.push(
        `${field.key}: unknown flag(s) ${check.unknown.join(", ")} for ${field.binary} ${field.command}`,
      );
    }
  }
  return problems;
}
