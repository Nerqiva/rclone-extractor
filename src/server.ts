import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { APP_PASSWORD, BIND, PORT } from "./config";
import { initDb, store, getSetting } from "./db";
import { recoverStale } from "./engine";
import { checkRclone, checkRclonex, Rclone } from "./rclone";
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

const rcloneHealth = await checkRclone();
if (rcloneHealth.ok) {
  console.log(`rclone ok: ${rcloneHealth.detail} (${rcloneHealth.bin})`);
} else {
  console.warn(`rclone not runnable: ${rcloneHealth.detail}`);
}

// When RcloneX extraction is enabled, probe its binary at boot too so a
// missing/wrong-arch build surfaces here instead of as per-archive spawn
// failures. RAR/7Z/ISO extraction fails without it.
if ((await getSetting("rclonex", "0")) === "1") {
  const rclonexHealth = await checkRclonex();
  if (rclonexHealth.ok) {
    console.log(`rclonex ok: ${rclonexHealth.detail} (${rclonexHealth.bin})`);
  } else {
    console.warn(
      `rclonex not runnable: ${rclonexHealth.detail} — RAR/7Z/ISO extraction will fail`,
    );
  }
}

const resume = (await getSetting("resume", "1")) === "1";
const recovered = await recoverStale(resume);
if (recovered > 0) {
  console.log(
    resume
      ? `boot: recovered ${recovered} stale archive(s)`
      : `boot: marked ${recovered} killed archive(s) as failed`,
  );
}

// Best-effort cleanup of temp dirs left behind by previous runs (e.g. after
// a crash). Only app-owned numeric directories inside the configured
// tmp_dir are purged; anything else is left alone. Honors dry_run.
const tmpBoot = await loadTmpDirSettings();
if (tmpBoot.spec) {
  try {
    const rcBoot = await Rclone.fromSettings();
    const res = await rcBoot.purgeStaleTemp(
      tmpRootPath(tmpBoot.scanRoot, tmpBoot.spec),
      tmpBoot.dryRun,
    );
    if (res.purged.length) {
      const verb = tmpBoot.dryRun ? "would purge (dry run)" : "purged";
      console.log(`boot: ${verb} ${res.purged.length} stale temp dir(s): ${res.purged.join(", ")}`);
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

const app = new Hono();

// Render (and every PaaS) stops the instance with SIGTERM. Close the database
// pool so the remote Postgres releases our connection slots immediately
// instead of holding them until TCP keepalive times out.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; closing database connections`);
  try {
    await Logger.flushAll();
  } catch (e) {
    console.warn(`error flushing logs: ${String(e)}`);
  }
  // Mark any in-flight run killed with the actual cause and time, instead
  // of leaving it for the next boot to discover. Signal-driven
  // (deploy/restart) is how most "unintentional" kills happen;
  // a hard kill still falls back to the boot-time recovery below.
  try {
    const resume = (await getSetting("resume", "1")) === "1";
    const recovered = await recoverStale(
      resume,
      `received ${signal} (deploy or restart)`,
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

// HTML is live run state, never cacheable — the browser must not serve a
// stale progress page on Back/Forward. /public/* assets keep default caching;
// the log download already marks itself no-store.
app.use("*", async (c, next) => {
  await next();
  if (
    !c.req.path.startsWith("/public/") &&
    !c.req.path.startsWith("/healthz") &&
    !c.res.headers.has("Cache-Control")
  ) {
    c.header("Cache-Control", "no-store");
  }
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

console.log(`rclone-extractor listening on http://${BIND}:${PORT} (db=${store.backend()})`);

export default {
  port: PORT,
  hostname: BIND,
  // Expose the socket IP to handlers (login throttling) without trusting
  // spoofable proxy headers unless TRUST_PROXY=1 is set.
  fetch: (req: Request, server?: { requestIP?: (r: Request) => { address: string } | null }) =>
    app.fetch(req, { ip: server?.requestIP?.(req)?.address }),
};
