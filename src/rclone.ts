import { getSetting, store } from "./db";
import { existsSync } from "node:fs";
import { isSupported } from "./archive";
import { isAbsoluteTmpPath, type SweepResult } from "./tmpdir";
import { RCLONE_CONF, RCLONE_CONF_PATH, ensureDataDir, RCLONE_BIN } from "./config";
import { normalizeRcloneConf } from "./rcloneconf";
import type { Logger } from "./log";

type SpawnError = Error & { code?: string };

/**
 * Map Bun's raw posix_spawn errors onto a single actionable message. The raw
 * ENOEXEC ("unknown error, posix_spawn 'rclone'") is unusable in a deploy log,
 * so callers get the probable cause and the fix (matching arch, or RCLONE_BIN).
 */
export function describeSpawnError(e: unknown, bin: string): string {
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
    `could not start rclone (${code || "unknown error"}): ${hint}. ` +
    `bin=${bin}. Install the rclone build matching this CPU or set RCLONE_BIN to a full path.`
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
    const wrapped = new Error(describeSpawnError(e, bin)) as Error & {
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
  files: number;
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
  kind: "rclone" | "extract";
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

function parseListLine(line: string): { rel: string; size: number } | null {
  const idx = line.lastIndexOf(";");
  if (idx === -1) return null;
  let rel = line.slice(0, idx);
  const size = Number(line.slice(idx + 1));
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return null;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (!isSupported(name)) return null;
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

/**
 * Probe the configured rclone once per process. Used at boot (so a broken
 * binary is visible in the deploy logs) and on the config page. Never throws.
 */
export function checkRclone(): Promise<RcloneHealth> {
  healthCache ??= probeRclone();
  return healthCache;
}

async function probeRclone(): Promise<RcloneHealth> {
  const bin = RCLONE_BIN;
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
      return { ok: true, bin, detail: detail ?? "rclone" };
    }
    return {
      ok: false,
      bin,
      detail: (err || out || `exit ${code}`).trim(),
    };
  } catch (e) {
    return { ok: false, bin, detail: describeSpawnError(e, bin) };
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

export class Rclone {
  onCommand?: (command: string) => void;

  constructor(
    public bin: string,
    public root: string,
    public flags: string[],
    private runLog?: Logger,
    private confPath?: string,
  ) {}

  // rclone only reads a config file passed via --config. Without this the
  // subprocess falls back to ~/.config/rclone/rclone.conf and errors with
  // "didn't find section in config file".
  private confArgs(): string[] {
    return this.confPath ? ["--config", this.confPath] : [];
  }

  static async fromSettings(runLog?: Logger): Promise<Rclone> {
    const root = (await getSetting("scan_root", "")) ?? "";
    const flagsRaw = (await getSetting("remote_flags", "")) ?? "";
    const flags = stripConfFlags(flagsRaw.split(/\s+/).filter((f) => f.length > 0));

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
      if (ensureDataDir()) {
        await Bun.write(RCLONE_CONF_PATH, conf);
      } else {
        console.warn(
          `could not write ${RCLONE_CONF_PATH}: data directory not writable; relying on existing rclone config`,
        );
      }
    }

    const confPath = existsSync(RCLONE_CONF_PATH) ? RCLONE_CONF_PATH : undefined;
    return new Rclone(RCLONE_BIN, root, flags, runLog, confPath);
  }

  private announce(args: string[]): string {
    const command = [this.bin, ...redactArgs(args)].map(quoteArg).join(" ");
    this.onCommand?.(command);
    this.runLog?.info(`$ ${command}`);
    return command;
  }

  private async nextSeq(ref: RcloneRef): Promise<number> {
    const row = await store.get1<{ m: number | null }>(
      "SELECT MAX(seq) AS m FROM log_lines WHERE scope=? AND ref_id=? AND kind=?",
      [ref.scope, ref.refId, ref.kind],
    );
    return Number(row?.m ?? -1) + 1;
  }

  private async appendArchiveLines(
    ref: RcloneRef,
    lines: string[],
    seq: number,
  ): Promise<void> {
    const ts = new Date().toISOString();
    for (const line of lines) {
      await store.run(
        "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [ref.scope, ref.refId, ref.kind, seq++, ts, null, line],
      );
    }
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
      "lsf",
      ...this.confArgs(),
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
      const parsed = parseListLine(line.replace(/\r$/, ""));
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
   * counts. The command and, on failure, stderr are appended to the archive
   * log. Never throws for listing failures; spawn failures propagate.
   */
  async archiveList(
    rel: string,
    ref: RcloneRef,
    onEntry: (entry: ArchiveEntry) => void,
  ): Promise<ArchiveListOutcome> {
    const args = [
      "archive",
      "list",
      `${this.root}/${rel}`,
      "--files-only",
      ...this.confArgs(),
      ...this.flags,
    ];
    const command = this.announce(args);

    let seq = await this.nextSeq(ref);
    await this.appendArchiveLines(ref, [`$ ${command}`], seq);
    seq++;

    const proc = spawnBinary(this.bin, args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderrPromise = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let buffer = "";
    let files = 0;
    let streamError: string | undefined;

    const consume = (line: string): void => {
      const parsed = parseArchiveListLine(line.replace(/\r$/, ""));
      if (!parsed) return;
      files++;
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

    if (streamError || code !== 0) {
      const lines = [`archive list failed (exit ${code})`];
      const tail = [stderr, streamError ?? ""].filter(Boolean).join("\n").trim();
      if (tail) lines.push(tail);
      await this.appendArchiveLines(ref, lines, seq);
    }

    return { code, tail: [], stderr, command, files, streamError };
  }

  /** Append informational lines to an archive's log. Never throws. */
  async note(ref: RcloneRef, lines: string[]): Promise<void> {
    try {
      const seq = await this.nextSeq(ref);
      await this.appendArchiveLines(ref, lines, seq);
    } catch (e) {
      console.warn("could not write archive note:", e);
    }
  }

  /**
   * Run a command. When `ref` is given, the command and its output are
   * appended to that archive's log; without a ref the command still goes to
   * the run log via `announce()`.
   */
  async run(args: string[], dry: boolean, ref?: RcloneRef): Promise<Outcome> {
    const full = [...this.confArgs(), ...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const command = this.announce(full);

    let seq = ref ? await this.nextSeq(ref) : 0;
    if (ref) {
      await this.appendArchiveLines(ref, [`$ ${command}`], seq);
      seq++;
    }

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
    if (ref) await this.appendArchiveLines(ref, combined, seq);

    return { code, tail: combined.slice(-40), stderr: err, command };
  }

  /**
   * Extract an archive. Unlike `run()`, stderr/stdout are streamed line by
   * line so `--stats-one-line` progress (printed once per second) can be
   * forwarded live via `onStats` and filtered out of the archive log. The
   * log gets the command line and every non-stats line, same as before.
   */
  async extract(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: RcloneRef,
    onStats?: (stats: ExtractStats) => void,
  ): Promise<Outcome> {
    const args = [
      "archive",
      "extract",
      `${this.root}/${rel}`,
      this.fullPath(tmp),
      "--stats",
      "1s",
      "--stats-one-line",
      // rclone logs --stats output at INFO, which the default NOTICE log
      // level suppresses; without this the flags above produce no output.
      "--log-level",
      "INFO",
    ];
    const full = [...this.confArgs(), ...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const command = this.announce(full);

    let seq = ref ? await this.nextSeq(ref) : 0;
    if (ref) {
      await this.appendArchiveLines(ref, [`$ ${command}`], seq);
      seq++;
    }

    const proc = spawnBinary(this.bin, full, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const kept: string[] = [];
    const handleLine = (raw: string) => {
      const line = raw.replace(/\r$/, "");
      const stats = parseStatsLine(line);
      if (stats) {
        onStats?.(stats);
        return; // per-second stats lines are not logged
      }
      if (line.length > 0) kept.push(line);
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
    if (ref && kept.length > 0) await this.appendArchiveLines(ref, kept, seq);
    const code = await proc.exited;

    return { code, tail: kept.slice(-40), stderr: kept.join("\n"), command };
  }

  async promote(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: RcloneRef,
    tmpTopSegment: string | null,
  ): Promise<Outcome> {
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
    ];
    if (tmpTopSegment) args.push("--exclude", `/${tmpTopSegment}/**`);
    return this.run(args, dry, ref);
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
      "lsf",
      ...this.confArgs(),
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

  async trash(rel: string, subdir: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    return this.run(
      ["moveto", `${this.root}/${rel}`, `${this.root}/${subdir}/${rel}`],
      dry,
      ref,
    );
  }
}
