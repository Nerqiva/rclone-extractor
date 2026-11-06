/**
 * rclone.conf input normalisation.
 *
 * The setting/env value may be a base64-encoded config (easy to pass through
 * deployment environment variables) or a legacy plain-text INI config.
 */

export type RcloneConfResult =
  | { ok: true; text: string; base64: string }
  | { ok: false; error: string };

const SECTION_RE = /(^|\r?\n)\s*\[[^\]\r\n]+\]\s*(\r?\n|$)/;

function looksLikeIni(value: string): boolean {
  return SECTION_RE.test(value);
}

function tryDecodeBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, "");
  if (!compact) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  if (compact.length % 4 === 1) return null;

  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  try {
    const buf = Buffer.from(padded, "base64");
    // Buffer.from is forgiving about invalid input; re-encoding catches that.
    if (buf.toString("base64") !== padded) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function normalizeRcloneConf(input: string): RcloneConfResult {
  const value = input.trim();
  if (!value) return { ok: true, text: "", base64: "" };

  const decoded = tryDecodeBase64(value);
  if (decoded !== null) {
    const text = decoded.replace(/^\uFEFF/, "");
    if (looksLikeIni(text)) {
      return { ok: true, text, base64: Buffer.from(text, "utf8").toString("base64") };
    }
  }

  // Backwards compatibility: older releases stored the config as plain INI.
  if (looksLikeIni(value)) {
    return { ok: true, text: value, base64: Buffer.from(value, "utf8").toString("base64") };
  }

  return {
    ok: false,
    error: "not a valid rclone.conf (expected base64-encoded INI or plain INI)",
  };
}

/** Decode a stored value for use on disk. Returns "" when invalid. */
export function decodeRcloneConf(input: string): string {
  const result = normalizeRcloneConf(input);
  return result.ok ? result.text : "";
}
