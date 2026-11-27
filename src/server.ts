import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { APP_PASSWORD, BIND, PORT } from "./config";
import { initDb, store, getSetting } from "./db";
import { recoverStale } from "./engine";
import { liveRunIds } from "./runs";
import { checkRclone, checkRclonex, Rclone, killActiveProcs } from "./rclone";
import { tmpRootPath } from "./tmpdir";
import { loadTmpDirSettings } from "./tmpsweep";
import { auth, authMiddleware, csrfMiddleware } from "./routes/auth";
import { Logger } from "./log";
import { pages } from "./routes/pages";
import { dashboard } from "./routes/dashboard";
import { actions } from "./routes/actions";
import { logsapi } from "./routes/logsapi";
import { data } from "./routes/data";

await initDb();

if (!APP_PASSWORD) {
  console.warn("APP_PASSWORD is not set; login is disabled.");
}

/**
 * Health probes, stale-run recovery and temp sweeping are not needed to accept
 * the first request. Run them after the module is evaluated so listen is not
 * blocked on rclone subprocesses or a large recovery.
 */
async function bootChecks(): Promise<void> {
  const rcloneHealth = await checkRclone();
  if (rcloneHealth.ok) {
    console.log(`rclone ok: ${rcloneHealth.detail} (${rcloneHealth.bin})`);
  } else {
    console.warn(`rclone not runnable: ${rcloneHealth.detail}`);
  }

  const rclonexHealth = await checkRclonex();
  if (rclonexHealth.ok) {
    console.log(`rclonex ok: ${rclonexHealth.detail} (${rclonexHealth.bin})`);
  } else {
    console.warn(
      `rclonex not runnable: ${rclonexHealth.detail} — RAR/7Z/ISO extraction will fail`,
    );
  }

  const resume = (await getSetting("resume", "1")) === "1";
  const recovered = await recoverStale(resume, undefined, undefined, true);
  if (recovered > 0) {
    console.log(
      resume
        ? `boot: recovered ${recovered} stale archive(s)`
        : `boot: marked ${recovered} killed archive(s) as failed`,
    );
  }

  const tmpBoot = await loadTmpDirSettings();
  if (tmpBoot.spec) {
    try {
      const rcBoot = await Rclone.fromSettings();
      const res = await rcBoot.purgeStaleTemp(
        tmpRootPath(tmpBoot.scanRoot, tmpBoot.spec),
        await liveRunIds(),
      );
      if (res.purged.length) {
        console.log(`boot: purged ${res.purged.length} stale temp dir(s): ${res.purged.join(", ")}`);
      }
      if (res.failed.length) {
        console.warn(`boot: could not purge temp dir(s): ${res.failed.join(", ")}`);
      }
    } catch (e) {
      console.warn(`boot: temp sweep failed: ${e}`);
    }
  } else {
    console.warn(`boot: invalid tmp_dir setting (${tmpBoot.raw}); skipping temp sweep`);
  }
}

const app = new Hono();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; closing database connections`);
  killActiveProcs();
  try {
    await Logger.flushAll();
  } catch (e) {
    console.warn(`error flushing logs: ${String(e)}`);
  }
  try {
    const resume = (await getSetting("resume", "1")) === "1";
    const recovered = await recoverStale(
      resume,
      `received ${signal} (deploy or restart)`,
      undefined,
      true,
    );
    if (recovered > 0) {
      console.log(
        `shutdown: marked ${recovered} killed archive(s) for recovery`,
      );
    }
  } catch (e) {
    console.warn(`error settling interrupted run: ${String(e)}`);
  }
  try {
    await store.close();
  } catch (e) {
    console.warn(`error closing database: ${String(e)}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app.get("/healthz", (c) => c.text("ok"));

app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  if (
    !c.req.path.startsWith("/public/") &&
    !c.req.path.startsWith("/healthz") &&
    !c.res.headers.has("Cache-Control")
  ) {
    c.header("Cache-Control", "no-store");
  }
});

app.use("/public/*", async (c, next) => {
  c.header("Cache-Control", "public, max-age=0, must-revalidate");
  await next();
});
app.use("/public/*", serveStatic({ root: "./" }));

app.use("*", authMiddleware);
app.use("*", csrfMiddleware);

app.route("/", auth);
app.route("/", pages);
app.route("/", dashboard);
app.route("/", actions);
app.route("/", logsapi);
app.route("/", data);

void bootChecks().catch((e) => console.warn(`boot checks failed: ${String(e)}`));

console.log(`rclone-extractor listening on http://${BIND}:${PORT} (db=${store.backend()})`);

export default {
  port: PORT,
  hostname: BIND,
  fetch: (req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }) =>
    app.fetch(req, { ip: server?.requestIP?.(req)?.address }),
};
