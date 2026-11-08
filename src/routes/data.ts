import { Hono } from "hono";
import { store, allSettings, setSetting, SECRET_KEYS } from "../db";
import { encryptionEnabled } from "../crypto";

export const data = new Hono();

data.post("/export", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const includeSecrets = form?.get("include_rclone") != null;

  const settings = await allSettings();
  const payload: Record<string, unknown> = {
    version: 1,
    exported_at: new Date().toISOString(),
    settings: includeSecrets ? settings : omitSecrets(settings),
    archives: await store.query("SELECT * FROM archives"),
    runs: await store.query("SELECT * FROM runs"),
    logs: await store.query("SELECT * FROM logs"),
    log_lines: await store.query("SELECT * FROM log_lines"),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename=export-${Date.now()}.json`,
    },
  });
});

function omitSecrets(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) {
    out[k] = SECRET_KEYS.has(k) ? "" : v;
  }
  return out;
}

data.post("/import", async (c) => {
  const form = await c.req.formData();
  const file = form.get("archive");
  if (!(file instanceof File)) {
    return c.json({ ok: false, message: "no archive uploaded" }, 400);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return c.json({ ok: false, message: `invalid JSON: ${String(e)}` }, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return c.json({ ok: false, message: "invalid backup: expected a JSON object" }, 400);
  }

  const counts: string[] = [];

  const settings = parsed.settings as Record<string, string> | undefined;
  if (settings) {
    for (const [k, v] of Object.entries(settings)) {
      if (k === "password") continue; // legacy setting; login uses APP_PASSWORD only
      if (typeof v === "string") await setSetting(k, v);
    }
    counts.push(`settings`);
  }

  const archives = parsed.archives as Record<string, unknown>[] | undefined;
  if (Array.isArray(archives)) {
    for (const a of archives) {
      await store.run(
        "INSERT OR REPLACE INTO archives(id, path, size, status, error_kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [a.id, a.path, a.size, a.status, a.error_kind, a.created_at, a.updated_at],
      );
    }
    counts.push(`${archives.length} archives`);
  }

  const runs = parsed.runs as Record<string, unknown>[] | undefined;
  if (Array.isArray(runs)) {
    for (const r of runs) {
      await store.run(
        "INSERT OR REPLACE INTO runs(id, started_at, finished_at, total, done, failed, skipped, interrupted) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        [r.id, r.started_at, r.finished_at, r.total, r.done, r.failed, r.skipped, r.interrupted ?? 0],
      );
    }
    counts.push(`${runs.length} runs`);
  }

  const logLines = parsed.log_lines as Record<string, unknown>[] | undefined;
  if (Array.isArray(logLines)) {
    for (const l of logLines) {
      await store.run(
        "INSERT INTO log_lines(scope, ref_id, kind, seq, ts, level, line) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [l.scope, l.ref_id, l.kind, l.seq, l.ts, l.level, l.line],
      );
    }
    counts.push(`${logLines.length} log lines`);
  }

  const enc = encryptionEnabled()
    ? "Secrets re-encrypted with the current key."
    : "Encryption off: secrets stored in plaintext.";
  return c.json({
    ok: true,
    message: `Imported ${counts.join(", ") || "nothing"}. ${enc}`,
  });
});
