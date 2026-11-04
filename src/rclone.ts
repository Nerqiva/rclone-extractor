import { getSetting } from "./db";
import { store } from "./db";
import { isSupported } from "./archive";
import { RCLONE_CONF_PATH } from "./config";

export type Outcome = { code: number; tail: string[]; stderr: string };

export class Rclone {
  constructor(
    public bin: string,
    public root: string,
    public flags: string[],
  ) {}

  static async fromSettings(): Promise<Rclone> {
    const root = (await getSetting("scan_root", "")) ?? "";
    const flagsRaw = (await getSetting("remote_flags", "")) ?? "";
    const flags = flagsRaw.split(/\s+/).filter((f) => f.length > 0);

    const conf = (await getSetting("rclone_conf", "")) ?? "";
    if (conf) await Bun.write(RCLONE_CONF_PATH, conf);

    return new Rclone("rclone", root, flags);
  }

  async list(onFile: (rel: string, size: number) => void | Promise<void>): Promise<void> {
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
    const proc = Bun.spawn([this.bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const out = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    await proc.exited;

    for (const line of out.split("\n")) {
      if (!line) continue;
      const idx = line.lastIndexOf(";");
      if (idx === -1) continue;
      let path = line.slice(0, idx);
      const size = line.slice(idx + 1);
      if (path.startsWith("./")) path = path.slice(2);
      if (!path) continue;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!isSupported(name)) continue;
      await onFile(path, Number(size));
    }
  }

  async run(
    args: string[],
    dry: boolean,
    ref: { scope: "archive"; refId: number; kind: "rclone" | "extract" },
  ): Promise<Outcome> {
    const full = [...args, ...this.flags];
    if (dry) full.push("--dry-run");
    const proc = Bun.spawn([this.bin, ...full], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;

    const combined = `${out}${err}`.split("\n").filter((l) => l.length > 0);
    const stamp = new Date().toISOString();
    let seq = 0;
    for (const line of combined) {
      await store.run(
        "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [ref.scope, ref.refId, ref.kind, seq++, stamp, null, line],
      );
    }

    return { code, tail: combined.slice(-40), stderr: err };
  }

  async extract(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: { scope: "archive"; refId: number; kind: "rclone" | "extract" },
  ): Promise<Outcome> {
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

  async promote(
    rel: string,
    tmp: string,
    dry: boolean,
    ref: { scope: "archive"; refId: number; kind: "rclone" | "extract" },
  ): Promise<Outcome> {
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

  async cleanup(
    tmp: string,
    dry: boolean,
    ref: { scope: "archive"; refId: number; kind: "rclone" | "extract" },
  ): Promise<Outcome> {
    return this.run(["purge", `${this.root}/${tmp}`], dry, ref);
  }

  async trash(
    rel: string,
    subdir: string,
    dry: boolean,
    ref: { scope: "archive"; refId: number; kind: "rclone" | "extract" },
  ): Promise<Outcome> {
    return this.run(
      ["moveto", `${this.root}/${rel}`, `${this.root}/${subdir}/${rel}`],
      dry,
      ref,
    );
  }
}
