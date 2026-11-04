import { Hono } from "hono";
import { existsSync, renameSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, allSettings, setSetting } from "../db";
import { DATA_DIR } from "../config";

export const data = new Hono();

data.post("/export", async (c) => {
  db.exec("PRAGMA wal_checkpoint(FULL)");
  await Bun.write(`${DATA_DIR}/settings.json`, JSON.stringify(allSettings(), null, 2));

  const form = await c.req.formData().catch(() => null);
  const includeRclone = form?.get("include_rclone") != null;

  const members = ["app.db", "logs", "settings.json"];
  if (includeRclone && existsSync(`${DATA_DIR}/rclone.conf`)) members.push("rclone.conf");

  const p = Bun.spawn(["tar", "czf", "-", "-C", DATA_DIR, ...members], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new Response(p.stdout, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename=export-${Date.now()}.tar.gz`,
    },
  });
});

data.post("/import", async (c) => {
  const form = await c.req.formData();
  const file = form.get("archive");
  if (!(file instanceof File)) return c.text("no archive uploaded", 400);

  const work = mkdtempSync(join(tmpdir(), "rx-import-"));
  const tarPath = join(work, "upload.tar.gz");
  await Bun.write(tarPath, file);

  const extractDir = join(work, "x");
  mkdirSync(extractDir, { recursive: true });
  const ex = Bun.spawn(["tar", "xzf", tarPath, "-C", extractDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(ex.stderr).text();
  const code = await ex.exited;
  if (code !== 0) return c.text(`extract failed: ${err}`, 400);

  let imported: string[] = [];

  if (existsSync(`${DATA_DIR}/app.db`)) {
    renameSync(`${DATA_DIR}/app.db`, `${DATA_DIR}/app.db.bak`);
  }
  const newDb = join(extractDir, "app.db");
  if (existsSync(newDb)) {
    await Bun.write(`${DATA_DIR}/app.db`, Bun.file(newDb));
    imported.push("app.db");
  }

  const newLogs = join(extractDir, "logs");
  if (existsSync(newLogs)) {
    const oldLogs = `${DATA_DIR}/logs.old-${Date.now()}`;
    if (existsSync(`${DATA_DIR}/logs`)) renameSync(`${DATA_DIR}/logs`, oldLogs);
    const mv = Bun.spawn(["cp", "-r", newLogs, `${DATA_DIR}/logs`]);
    await mv.exited;
    imported.push("logs");
  }

  const newSettings = join(extractDir, "settings.json");
  if (existsSync(newSettings)) {
    const parsed = JSON.parse(await Bun.file(newSettings).text()) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) setSetting(k, String(v));
    imported.push("settings.json");
  }

  if (existsSync(join(extractDir, "rclone.conf"))) {
    await Bun.write(`${DATA_DIR}/rclone.conf`, Bun.file(join(extractDir, "rclone.conf")));
    imported.push("rclone.conf");
  }

  return c.html(
    `<p class="note">Imported: ${imported.join(", ") || "nothing"}. Backup at app.db.bak. Restart to load the new database.</p>`,
  );
});
