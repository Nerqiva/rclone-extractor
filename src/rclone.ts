import { writeFileSync, renameSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSetting } from "./db";
import { isSupported, isSafeRel, parseTrashSubdir } from "./archive";
import { isAbsoluteTmpPath, type SweepResult } from "./tmpdir";
import {
  RCLONE_CONF,
  RCLONE_CONF_PATH,
  RCLONE_CONF_FALLBACK_DIR,
  RCLONE_CONF_FALLBACK_PATH,
  RCLONE_BIN,
  RCLONEX_BIN,
} from "./config";
import { normalizeRcloneConf } from "./rcloneconf";
import { insertLogLines } from "./log";
import type { Logger } from "./log";

type SpawnError = Error & { code?: string };

/**
 * Map Bun's raw posix_spawn errors onto a single actionable message. The raw
 * ENOEXEC ("unknown error, posix_spawn 'rclone'") is unusable in a deploy log,
 * so callers get the probable cause and the fix (matching arch, or the
 * RCLONE_BIN/RCLONEX_BIN env var).
 */
export function describeSpawnError(
  e: unknown,
  bin: string,
  binEnv: string = "RCLONE_BIN",
): string {
  const err = (e ?? {}) as SpawnError;
  const code = err.code ?? "";
  let hint: string;
  switch (code) {
    case "ENOEXEC":
      hint =
        "the binary is built for a different CPU architecture or is corrupt (e.g. an arm64 container holding an amd64 rclone)";
      break;
    case "ENOENT":
      hint = "the binary is not installed or not on PATH";
      break;
    case "EACCES":
      hint = "the binary is not executable";
      break;
    case "ENOTDIR":
      hint = "a path component of the binary is not a directory";
      break;
    default:
      hint = String(err.message ?? e ?? "unknown error");
  }
  return (
    `could not start ${binEnv === "RCLONEX_BIN" ? "rclonex" : "rclone"} (${code || "unknown error"}): ${hint}. ` +
    `bin=${bin}. Install the build matching this CPU architecture or set ${binEnv} to a full path.`
  );
}

function spawnBinary(
  bin: string,
  args: string[],
  options: {
    stdout: "pipe";
    stderr: "pipe";
    stdin?: "pipe" | "inherit" | "ignore";
    env?: Record<string, string | undefined>;
    cwd?: string;
  },
) {
  try {
    const proc = Bun.spawn([bin, ...args], {
      ...options,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    activeProcs.add(proc);
    void proc.exited.finally(() => {
      activeProcs.delete(proc);
    });
    return proc;
  } catch (e) {
    // Error text only; the binary name decides which env var we suggest.
    const binEnv = bin.includes("rclonex") ? "RCLONEX_BIN" : "RCLONE_BIN";
    const wrapped = new Error(describeSpawnError(e, bin, binEnv)) as Error & {
      code?: string;
    };
    // Keep the original posix_spawn code so callers can format it without
    // nesting the already-friendly message inside itself.
    wrapped.code = (e as { code?: string } | undefined)?.code;
    throw wrapped;
  }
}

export type Outcome = {
  code: number;
  tail: string[];
  stderr: string;
  command: string;
};

export type ListOutcome = Outcome & {
  stopped: boolean;
  streamError?: string;
};

export type ArchiveListOutcome = Outcome & {
  streamError?: string;
};

export type ArchiveEntry = {
  path: string;
  size: number;
};

export type ExtractStats = {
  bytesDone: number;
  bytesTotal: number;
  /** 0-100, or null when rclone reports the percentage as "-". */
  percent: number | null;
  /** Bytes per second, or null when the rate cannot be determined. */
  speedBytesPerSec: number | null;
  /** Raw rclone ETA string ("43s", "1m30s"), or "" when unknown/"-". */
  etaText: string;
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
  eib: 1024 ** 6,
};

function sizeToBytes(value: string, unit: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n * (SIZE_UNITS[unit.toLowerCase()] ?? 1);
}

/**
 * Parse one line of rclone's `--stats-one-line` output, e.g.
 *   "2026/11/08 12:00:00 INFO  :   512.345 MiB / 1.000 GiB, 50%, 12.3 MiB/s, ETA 43s"
 * The line may or may not carry rclone's usual date/level prefix, and may end
 * with an "(xfr#1/1)" suffix. Returns null for anything that is not a stats line.
 */
export function parseStatsLine(line: string): ExtractStats | null {
  const m =
    /([\d.]+)\s*(EiB|PiB|TiB|GiB|MiB|KiB|B)\s*\/\s*([\d.]+)\s*(EiB|PiB|TiB|GiB|MiB|KiB|B),\s*(?:(\d+)%|-(?:%)?),\s*([\d.]+)\s*(EiB|PiB|TiB|GiB|MiB|KiB|B)\/s,\s*ETA\s+([^\s,("']+)/i.exec(
      line,
    );
  if (!m) return null;
  const eta = m[8] === "-" ? "" : m[8];
  return {
    bytesDone: sizeToBytes(m[1], m[2]),
    bytesTotal: sizeToBytes(m[3], m[4]),
    percent: m[5] === undefined ? null : Number(m[5]),
    speedBytesPerSec: sizeToBytes(m[6], m[7]),
    etaText: eta,
  };
}

export type RcloneRef = {
  scope: "archive";
  refId: number;
  kind: "extract";
};

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const SENSITIVE_FLAG = /(pass|secret|token|credential|api[-_]?key|access[-_]?key)/i;

// Every rclone process spawned by this module, tracked so a hard stop can
// kill whatever is currently running (extract/listing/archive list).
const activeProcs = new Set<Bun.Subprocess>();

/** SIGKILL every rclone process this module currently has in flight. */
export function killActiveProcs(): void {
  for (const proc of activeProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!SENSITIVE_FLAG.test(name)) {
      out.push(arg);
      continue;
    }
    if (eq !== -1) {
      out.push(`${name}=***`);
      continue;
    }
    out.push(name);
    if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      out.push("***");
      i++;
    }
  }
  return out;
}

function assertSafeRel(rel: string): void {
  if (!isSafeRel(rel)) throw new Error(`unsafe archive path refused: ${JSON.stringify(rel)}`);
}

function parseListLine(
  line: string,
  rclonex = false,
): { rel: string; size: number } | null {
  const idx = line.lastIndexOf(";");
  if (idx === -1) return null;
  let rel = line.slice(0, idx);
  const size = Number(line.slice(idx + 1));
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (!isSupported(name, rclonex)) return null;
  return { rel, size: Number.isFinite(size) ? size : 0 };
}

/**
 * Parse one line of `rclone archive list --files-only` output, which is
 * `<right-aligned size> <path>`. Returns null for blank/malformed lines and
 * for directories (they should not appear with --files-only, but guard
 * anyway). Paths keep any `./` prefix; callers only care about basenames.
 */
export function parseArchiveListLine(line: string): ArchiveEntry | null {
  const m = /^\s*(\d+)\s+(\S.*)$/.exec(line);
  if (!m) return null;
  const path = m[2].trimEnd();
  if (!path || path.endsWith("/")) return null;
  const size = Number(m[1]);
  if (!Number.isFinite(size)) return null;
  return { path, size };
}

export interface RcloneHealth {
  ok: boolean;
  bin: string;
  detail: string;
}

let healthCache: Promise<RcloneHealth> | null = null;
let healthCacheX: Promise<RcloneHealth> | null = null;

/**
 * Probe the configured rclone once per process. Used at boot (so a broken
 * binary is visible in the deploy logs) and on the config page. Never throws.
 */
export function checkRclone(): Promise<RcloneHealth> {
  healthCache ??= probe(RCLONE_BIN, "rclone");
  return healthCache;
}

/** Probe the configured rclonex once per process; mirrors checkRclone. */
export function checkRclonex(): Promise<RcloneHealth> {
  healthCacheX ??= probe(RCLONEX_BIN, "rclonex", "RCLONEX_BIN");
  return healthCacheX;
}

async function probe(
  bin: string,
  label: string,
  binEnv: string = "RCLONE_BIN",
): Promise<RcloneHealth> {
  try {
    const proc = spawnBinary(bin, ["version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(), 4000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);
    if (code === 0) {
      const detail = out.split("\n").map((l) => l.trim()).find(Boolean);
      return { ok: true, bin, detail: detail ?? label };
    }
    return {
      ok: false,
      bin,
      detail: (err || out || `exit ${code}`).trim(),
    };
  } catch (e) {
    return { ok: false, bin, detail: describeSpawnError(e, bin, binEnv) };
  }
}

function stripConfFlags(flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--config") {
      i++; // drop the value too
      continue;
    }
    if (f.startsWith("--config=")) continue;
    out.push(f);
  }
  return out;
}

/**
 * rclonex-only flags never belong on the plain rclone binary: any
 * `--archive-*` flag makes every rclone command fail with "unknown flag".
 * Drop the flag (and its value when it is not the next flag) from
 * remote_flags for the rclone runner; the rclonex runner keeps them.
 */
function stripRclonexFlags(flags: string[]): { flags: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (/^--archive-/i.test(f)) {
      dropped.push(f);
      if (!f.includes("=") && i + 1 < flags.length && !flags[i + 1].startsWith("-")) {
        dropped.push(flags[i + 1]); // drop the flag's value too
        i++;
      }
      continue;
    }
    out.push(f);
  }
  return { flags: out, dropped };
}

// The --config path is chosen lazily: the primary working copy lives under
// DATA_DIR (/app/data by default); when that path is not writable for any
// reason (read-only mount, EACCES, EROFS, full disk, ...) the working copy
// is kept at /tmp/app/data/rclone.conf instead and every rclone invocation
// is pointed there. effectiveConfPath flips back to the primary path once a
// write there succeeds again.
let effectiveConfPath = RCLONE_CONF_PATH;
let fallbackActive = false;
// Set when the fallback (or a total failure) is used; HTTP handlers consume
// it to show a toast. Boot-time fallbacks surface on the next dashboard poll.
let pendingConfNotice: string | null = null;

/** Return (and clear) the pending rclone.conf notice, sanitized for a toast. */
export function pendingRcloneConfNotice(): string | null {
  const notice = pendingConfNotice;
  pendingConfNotice = null;
  return notice;
}

function writeConfAtomic(path: string, conf: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, conf, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (e) {
    // Never leave a stray .tmp-* copy of the credentials behind.
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort; the temp file may not exist (or already be renamed).
    }
    throw e;
  }
}

/**
 * Write the stored rclone.conf working copy, falling back to /tmp/app/data
 * when the primary path fails for any reason. Returns a user-facing warning
 * when the fallback (or a total failure) had to be used, else null.
 */
function syncConfFile(conf: string): string | null {
  try {
    mkdirSync(dirname(RCLONE_CONF_PATH), { recursive: true });
    writeConfAtomic(RCLONE_CONF_PATH, conf);
    if (effectiveConfPath !== RCLONE_CONF_PATH) {
      effectiveConfPath = RCLONE_CONF_PATH;
      fallbackActive = false;
      console.log(`rclone.conf working copy is back at ${RCLONE_CONF_PATH}`);
    }
    return null;
  } catch (primaryErr) {
    console.warn(
      `could not write ${RCLONE_CONF_PATH} (${String(primaryErr)}); falling back to ${RCLONE_CONF_FALLBACK_PATH}`,
    );
  }
  try {
    mkdirSync(RCLONE_CONF_FALLBACK_DIR, { recursive: true, mode: 0o700 });
    writeConfAtomic(RCLONE_CONF_FALLBACK_PATH, conf);
    effectiveConfPath = RCLONE_CONF_FALLBACK_PATH;
    if (!fallbackActive) {
      fallbackActive = true;
      const msg = `${RCLONE_CONF_PATH} is not writable; stored rclone.conf is kept at ${RCLONE_CONF_FALLBACK_PATH} instead`;
      console.warn(msg);
      pendingConfNotice = msg;
      return msg;
    }
    return null;
  } catch (fallbackErr) {
    const msg = `rclone.conf could not be written to ${RCLONE_CONF_PATH} or ${RCLONE_CONF_FALLBACK_PATH}: ${String(fallbackErr)}`;
    console.warn(msg);
    pendingConfNotice = msg;
    fallbackActive = true;
    return msg;
  }
}

export class Rclone {
  onCommand?: (command: string) => void;

  constructor(
    public bin: string,
    public root: string,
    public flags: string[],
    private runLog?: Logger,
    /** True when RcloneX is enabled and its formats are eligible for queueing. */
    public rclonexEnabled: boolean = false,
  ) {}

  // The --config flag is hard-coded so rclone never falls back to
  // ~/.config/rclone/rclone.conf (which errors with "didn't find section in
  // config file"). When a stored/env rclone_conf is set, fromSettings()
  // keeps the working copy at the primary path (or the /tmp fallback when
  // the primary path is not writable); otherwise the file at the primary
  // path (e.g. a mounted rclone.conf) is used as-is. A --config in
  // remote_flags is stripped, not honored.
  private confArgs(): string[] {
    return ["--config", effectiveConfPath];
  }

  /**
   * Build an Rclone runner. By default it targets the rclone binary;
   * `opts.rclonex` targets the rclonex binary (Nerqiva/rclonex) with the same
   * flags and --config. The listing filter always reflects the rclonex
   * setting, so archives queued in a mixed run carry format info correctly.
   */
  static async fromSettings(
    runLog?: Logger,
    opts: { rclonex?: boolean } = {},
  ): Promise<Rclone> {
    const root = (await getSetting("scan_root", "")) ?? "";
    const flagsRaw = (await getSetting("remote_flags", "")) ?? "";
    const flagsRawList = stripConfFlags(
      flagsRaw.split(/\s+/).filter((f) => f.length > 0),
    );
    const rclonexEnabled = (await getSetting("rclonex", "0")) === "1";
    const stripped = opts.rclonex
      ? { flags: flagsRawList, dropped: [] as string[] }
      : stripRclonexFlags(flagsRawList);
    const flags = stripped.flags;
    if (stripped.dropped.length) {
      const warning = `remote_flags contained rclonex-only flags; ignored for rclone: ${stripped.dropped.join(" ")}`;
      console.warn(warning);
      runLog?.warn(warning);
    }

    const storedConf = (await getSetting("rclone_conf", "")) ?? "";
    let conf = "";
    for (const candidate of [storedConf, RCLONE_CONF]) {
      if (!candidate) continue;
      const parsed = normalizeRcloneConf(candidate);
      if (parsed.ok && parsed.text) {
        conf = parsed.text;
        break;
      }
      if (!parsed.ok) console.warn(`ignoring invalid rclone_conf: ${parsed.error}`);
    }

    if (conf) {
      // Write via a temp file + rename so a crash mid-write cannot leave a
      // truncated config, and never leave credentials world-readable. When
      // the primary path under DATA_DIR is not writable for any reason, the
      // working copy falls back to /tmp/app/data; a failure there is only a
      // warning — rclone itself will report the unreadable/missing file.
      const notice = syncConfFile(conf);
      if (notice) runLog?.warn(notice);
    }

    return new Rclone(
      opts.rclonex ? RCLONEX_BIN : RCLONE_BIN,
      root,
      flags,
      runLog,
      rclonexEnabled,
    );
  }

  private announce(args: string[]): string {
    const command = [this.bin, ...redactArgs(args)].map(quoteArg).join(" ");
    this.onCommand?.(command);
    this.runLog?.info(`$ ${command}`);
    return command;
  }

  /** Absolute paths (and `remote:` paths) are used as-is; relative ones are resolved against the scan root. */
  private fullPath(p: string): string {
    return isAbsoluteTmpPath(p) ? p : `${this.root}/${p}`;
  }

  async list(
    onFile: (
      rel: string,
      size: number,
    ) => boolean | void | Promise<boolean | void>,
  ): Promise<ListOutcome> {
    const args = [
      ...this.confArgs(),
      "lsf",
      this.root,
      "--recursive",
      "--files-only",
      "--format",
      "ps",
      "--separator",
      ";",
      ...this.flags,
    ];
    const command = this.announce(args);
    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderrPromise = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopped = false;
    let streamError: string | undefined;

    const consume = async (line: string): Promise<boolean> => {
      const parsed = parseListLine(line.replace(/\r$/, ""), this.rclonexEnabled);
      if (!parsed) return true;
      const more = await onFile(parsed.rel, parsed.size);
      return more !== false;
    };

    try {
      for await (const chunk of proc.stdout as unknown as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line && !(await consume(line))) {
            stopped = true;
            break;
          }
          idx = buffer.indexOf("\n");
        }
        if (stopped) break;
      }
      if (!stopped) {
        buffer += decoder.decode();
        if (buffer && !(await consume(buffer))) stopped = true;
      }
    } catch (e) {
      // This is not an intentional early stop (queue limit/cancel): surface it
      // as a real listing failure instead of silently reporting success.
      streamError = String(e);
      console.warn("listing stream failed:", streamError);
      proc.kill();
    }

    if (stopped) proc.kill();
    const stderr = await stderrPromise;
    const code = await proc.exited;
    return { code, tail: [], stderr, command, stopped, streamError };
  }

  /**
   * List the contents of an archive with `rclone archive list --files-only`.
   * Read-only, so no --dry-run is added even when dry-run mode is on; the
   * whole purpose is to inspect an archive before any extraction happens.
   * Entries are streamed to `onEntry` (O(1) memory); the caller aggregates
   * counts. On failure the raw stderr is appended to the archive log.
   * Never throws for listing failures; spawn failures propagate.
   */
  async archiveList(
    rel: string,
    ref: RcloneRef,
    onEntry: (entry: ArchiveEntry) => void,
  ): Promise<ArchiveListOutcome> {
    assertSafeRel(rel);
    const args = [
      ...this.confArgs(),
      "archive",
      "list",
      `${this.root}/${rel}`,
      "--files-only",
      ...this.flags,
    ];
    const command = this.announce(args);

    // No `$ command` pre-line: archive logs hold raw binary output only.
    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderrPromise = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError: string | undefined;

    const consume = (line: string): void => {
      const parsed = parseArchiveListLine(line.replace(/\r$/, ""));
      if (!parsed) return;
      onEntry(parsed);
    };

    try {
      for await (const chunk of proc.stdout as unknown as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line) consume(line);
          idx = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) consume(buffer);
    } catch (e) {
      streamError = String(e);
      console.warn("archive list stream failed:", streamError);
      proc.kill();
    }

    const stderr = await stderrPromise;
    const code = await proc.exited;

    // Raw binary output only — except that a failure with no output at all
    // still gets one diagnostic line so the error row's Copy/Download never
    // comes up empty (404).
    if (streamError || code !== 0) {
      let raw = [stderr.trim(), streamError ?? ""].filter(Boolean).join("\n");
      if (!raw) raw = `listing failed (exit ${code})`;
      await insertLogLines(ref, raw.split("\n"));
    }

    return { code, tail: [], stderr, command, streamError };
  }

  /**
   * Run a command. When `ref` is given, the binary's raw output lines are
   * appended to that archive's log; without a ref the command still goes to
   * the run log via `announce()`. Archive logs never carry app wording.
   */
  async run(args: string[], dry: boolean, ref?: RcloneRef): Promise<Outcome> {
    const full = [...this.confArgs(), ...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const command = this.announce(full);

    const proc = spawnBinary(this.bin, full, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const combined = `${out}\n${err}`
      .split("\n")
      .filter((line) => line.length > 0);
    if (ref && combined.length === 0 && code !== 0) {
      // Silent failure: still leave one diagnostic line so the error row's
      // Copy/Download is not an empty 404.
      combined.push(`command failed with exit ${code} (no output)`);
    }
    if (ref) await insertLogLines(ref, combined);

    return { code, tail: combined.slice(-40), stderr: err, command };
  }

  /**
   * Run a transfer command (archive extract, move, moveto) with `--stats`
   * output streamed line by line: per-second stats lines are forwarded live
   * via `onStats` and kept out of the archive log; every other raw line the
   * binary writes is appended verbatim (bounded batches, only the tail is
   * kept in memory). Archive logs never carry app wording.
   */
  private async streamTransfer(
    args: string[],
    dry: boolean,
    ref: RcloneRef,
    onStats?: (stats: ExtractStats) => void,
  ): Promise<Outcome> {
    const full = [...this.confArgs(), ...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const command = this.announce(full);

    // No `$ command` pre-line: archive logs hold raw binary output only.
    const proc = spawnBinary(this.bin, full, {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Output is streamed to the archive log in bounded batches instead of
    // buffered whole; only the tail is kept for the returned Outcome.
    const LOG_BATCH = 100;
    let pending: string[] = [];
    let loggedLines = 0;
    let flushChain: Promise<void> = Promise.resolve();
    const flush = (force = false): void => {
      if (pending.length === 0) return;
      if (!force && pending.length < LOG_BATCH) return;
      const batch = pending;
      pending = [];
      flushChain = flushChain.then(() =>
        insertLogLines(ref, batch).catch((e) => {
          console.warn("archive log write failed:", String(e));
        }),
      );
    };
    const tailLines: string[] = [];
    const handleLine = (raw: string) => {
      const line = raw.replace(/\r$/, "");
      const stats = parseStatsLine(line);
      if (stats) {
        onStats?.(stats);
        return; // per-second stats lines are not logged
      }
      if (line.length > 0) {
        tailLines.push(line);
        if (tailLines.length > 40) tailLines.shift();
        pending.push(line);
        loggedLines++;
        flush();
      }
    };
    const pump = async (
      stream: ReadableStream<Uint8Array> | null,
    ): Promise<void> => {
      if (!stream) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream as unknown as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    flush(true);
    await flushChain;
    const code = await proc.exited;
    if (loggedLines === 0 && code !== 0) {
      // Silent failure: still leave one diagnostic line so the error row's
      // Copy/Download is not an empty 404.
      await insertLogLines(ref, [`command failed with exit ${code} (no output)`]).catch(
        (e) => console.warn("archive log write failed:", String(e)),
      );
    }

    return {
      code,
      tail: tailLines,
      stderr: tailLines.slice(-20).join("\n"),
      command,
    };
  }

  async extract(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: RcloneRef,
    onStats?: (stats: ExtractStats) => void,
    extraFlags: string[] = [],
  ): Promise<Outcome> {
    assertSafeRel(rel);
    const args = [
      "archive",
      "extract",
      `${this.root}/${rel}`,
      this.fullPath(tmp),
      ...extraFlags,
      "--stats",
      "1s",
      "--stats-one-line",
      // rclone logs --stats output at INFO, which the default NOTICE log
      // level suppresses; without this the flags above produce no output.
      "--log-level",
      "INFO",
    ];
    return this.streamTransfer(args, dry, ref, onStats);
  }

  async promote(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: RcloneRef,
    tmpTopSegment: string | null,
    onStats?: (stats: ExtractStats) => void,
  ): Promise<Outcome> {
    assertSafeRel(rel);
    const idx = rel.lastIndexOf("/");
    const parent = idx === -1 ? "" : rel.slice(0, idx);
    const args = [
      "move",
      this.fullPath(tmp),
      `${this.root}/${parent}`,
      // rclone refuses to move when the source is nested inside the
      // destination (OverlappingFilterCheck). The tmp dir is inside the
      // scan root whenever it is configured as a relative path, so exclude
      // it from the destination traversal. The pattern is anchored to the
      // top level so archive contents that are themselves named like the
      // temp dir are still promoted. Absolute temp dirs need no exclusion.
      "--delete-empty-src-dirs",
      "--stats",
      "1s",
      "--stats-one-line",
      "--log-level",
      "INFO",
    ];
    if (tmpTopSegment) args.push("--exclude", `/${tmpTopSegment}/**`);
    return this.streamTransfer(args, dry, ref, onStats);
  }

  async cleanup(tmp: string, dry: boolean, ref?: RcloneRef): Promise<Outcome> {
    return this.run(["purge", this.fullPath(tmp)], dry, ref);
  }

  /** Remove an empty directory. Non-empty directories fail with code != 0. */
  async rmdir(path: string, dry: boolean, ref?: RcloneRef): Promise<Outcome> {
    return this.run(["rmdir", this.fullPath(path)], dry, ref);
  }

  /** Recursively delete a tree. */
  async purge(path: string, dry: boolean): Promise<Outcome> {
    return this.run(["purge", this.fullPath(path)], dry);
  }

  /** Top-level directory names of a remote path (no trailing slashes). Missing dir yields []. */
  async listTopDirs(path: string): Promise<string[]> {
    const args = [
      ...this.confArgs(),
      "lsf",
      this.fullPath(path),
      "--dirs-only",
      "--format",
      "p",
      ...this.flags,
    ];
    this.announce(args);
    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return [];
    return out
      .split("\n")
      .map((l) => l.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }

  /**
   * Delete stale app-owned entries (`<digits>` run dirs) inside the temp
   * root. Anything else is left untouched. Returns what was purged.
   */
  async purgeStaleTemp(tmpRoot: string, dry: boolean): Promise<SweepResult> {
    const tops = await this.listTopDirs(tmpRoot);
    const result: SweepResult = { purged: [], skipped: [], failed: [] };
    for (const name of tops) {
      if (!/^\d+$/.test(name)) {
        result.skipped.push(name);
        continue;
      }
      const res = await this.purge(`${tmpRoot}/${name}`, dry);
      if (res.code === 0) result.purged.push(name);
      else result.failed.push(name);
    }
    return result;
  }

  async trash(
    rel: string,
    subdir: string,
    dry: boolean,
    ref: RcloneRef,
    onStats?: (stats: ExtractStats) => void,
  ): Promise<Outcome> {
    assertSafeRel(rel);
    if (!parseTrashSubdir(subdir)) {
      throw new Error(`unsafe trash_subdir refused: ${JSON.stringify(subdir)}`);
    }
    return this.streamTransfer(
      [
        "moveto",
        `${this.root}/${rel}`,
        `${this.root}/${subdir}/${rel}`,
        "--stats",
        "1s",
        "--stats-one-line",
        "--log-level",
        "INFO",
      ],
      dry,
      ref,
      onStats,
    );
  }

  /**
   * True when `root/<rel>` exists and is non-empty. Used to refuse webapp
   * moves (delete/restore) that would overwrite something already in place.
   */
  async existsPath(rel: string): Promise<boolean> {
    assertSafeRel(rel);
    const args = [...this.confArgs(), "lsl", `${this.root}/${rel}`, ...this.flags];
    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 && out.trim().length > 0;
  }

  /**
   * Move `root/<srcRel>` to `root/<dstRel>` for webapp actions (delete to
   * trash, restore from trash). Refuses to overwrite the destination
   * (`--immutable`); the caller should also check `existsPath` for a clear
   * error message. Logs raw binary output to the archive's log.
   */
  async moveToRel(srcRel: string, dstRel: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    assertSafeRel(srcRel);
    assertSafeRel(dstRel);
    return this.streamTransfer(
      ["moveto", `${this.root}/${srcRel}`, `${this.root}/${dstRel}`, "--immutable"],
      dry,
      ref,
    );
  }

  /**
   * Stream a single remote file (`rclone cat`) without buffering it — the
   * route pipes `stdout` straight into its own response. `exited` resolves
   * after EOF; on a non-zero exit the caller should log `stderr`.
   */
  async openCat(
    rel: string,
  ): Promise<{
    stdout: ReadableStream;
    exited: Promise<number>;
    stderr: Promise<string>;
    command: string;
  }> {
    assertSafeRel(rel);
    const args = [...this.confArgs(), "cat", `${this.root}/${rel}`, ...this.flags];
    const command = this.announce(args);
    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: proc.stdout as unknown as ReadableStream,
      exited: proc.exited,
      stderr: new Response(proc.stderr).text(),
      command,
    };
  }
}
