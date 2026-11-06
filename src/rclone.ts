import { getSetting, store } from "./db";
import { isSupported } from "./archive";
import { RCLONE_CONF, RCLONE_CONF_PATH, ensureDataDir } from "./config";
import { normalizeRcloneConf } from "./rcloneconf";
import type { Logger } from "./log";

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

export class Rclone {
  onCommand?: (command: string) => void;

  constructor(
    public bin: string,
    public root: string,
    public flags: string[],
    private runLog?: Logger,
  ) {}

  static async fromSettings(runLog?: Logger): Promise<Rclone> {
    const root = (await getSetting("scan_root", "")) ?? "";
    const flagsRaw = (await getSetting("remote_flags", "")) ?? "";
    const flags = flagsRaw.split(/\s+/).filter((f) => f.length > 0);

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

    return new Rclone("rclone", root, flags, runLog);
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

  async list(
    onFile: (
      rel: string,
      size: number,
    ) => boolean | void | Promise<boolean | void>,
  ): Promise<ListOutcome> {
    const args = [
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
    const proc = Bun.spawn([this.bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
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

  async run(args: string[], dry: boolean, ref: RcloneRef): Promise<Outcome> {
    const full = [...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const command = this.announce(full);

    let seq = await this.nextSeq(ref);
    await this.appendArchiveLines(ref, [`$ ${command}`], seq);
    seq++;

    const proc = Bun.spawn([this.bin, ...full], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const combined = `${out}\n${err}`
      .split("\n")
      .filter((line) => line.length > 0);
    await this.appendArchiveLines(ref, combined, seq);

    return { code, tail: combined.slice(-40), stderr: err, command };
  }

  async extract(rel: string, tmp: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    return this.run(
      [
        "archive",
        "extract",
        `${this.root}/${rel}`,
        `${this.root}/${tmp}`,
        "--stats",
        "1s",
        "--stats-one-line",
      ],
      dry,
      ref,
    );
  }

  async promote(rel: string, tmp: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    const idx = rel.lastIndexOf("/");
    const parent = idx === -1 ? "" : rel.slice(0, idx);
    return this.run(
      [
        "move",
        `${this.root}/${tmp}`,
        `${this.root}/${parent}`,
        "--delete-empty-src-dirs",
      ],
      dry,
      ref,
    );
  }

  async cleanup(tmp: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    return this.run(["purge", `${this.root}/${tmp}`], dry, ref);
  }

  async trash(rel: string, subdir: string, dry: boolean, ref: RcloneRef): Promise<Outcome> {
    return this.run(
      ["moveto", `${this.root}/${rel}`, `${this.root}/${subdir}/${rel}`],
      dry,
      ref,
    );
  }
}
