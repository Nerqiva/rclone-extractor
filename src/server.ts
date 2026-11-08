import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { APP_PASSWORD, BIND, PORT } from "./config";
import { initDb, store, getSetting } from "./db";
import { recoverStale } from "./engine";
import { checkRclone, Rclone } from "./rclone";
import { parseTmpDir, tmpRootPath, TMP_DIR_DEFAULT } from "./tmpdir";
import { auth, authMiddleware } from "./routes/auth";
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

const resume = (await getSetting("resume", "1")) === "1";
const recovered = await recoverStale(resume);
if (recovered > 0) console.log(`boot: recovered ${recovered} stale archive(s)`);

// Best-effort cleanup of temp dirs left behind by previous runs (e.g. after
// a crash). Only app-owned numeric directories inside the configured
// tmp_dir are purged; anything else is left alone. Honors dry_run.
const dryRunBoot = (await getSetting("dry_run", "0")) === "1";
const scanRootBoot = (await getSetting("scan_root", "")) ?? "";
const trashBoot = (await getSetting("trash_subdir", "trash")) ?? "trash";
const tmpRawBoot = ((await getSetting("tmp_dir", TMP_DIR_DEFAULT)) ?? TMP_DIR_DEFAULT).trim();
const tmpSpecBoot = tmpRawBoot
  ? parseTmpDir(tmpRawBoot, scanRootBoot, trashBoot)
  : { kind: "relative" as const, value: TMP_DIR_DEFAULT };
if (tmpSpecBoot) {
  try {
    const rcBoot = await Rclone.fromSettings();
    const res = await rcBoot.purgeStaleTemp(tmpRootPath(scanRootBoot, tmpSpecBoot), dryRunBoot);
    if (res.purged.length) {
      const verb = dryRunBoot ? "would purge (dry run)" : "purged";
      console.log(`boot: ${verb} ${res.purged.length} stale temp dir(s): ${res.purged.join(", ")}`);
    }
    if (res.failed.length) {
      console.warn(`boot: could not purge temp dir(s): ${res.failed.join(", ")}`);
    }
  } catch (e) {
    console.warn(`boot: temp sweep failed: ${e}`);
  }
} else {
  console.warn(`boot: invalid tmp_dir setting (${tmpRawBoot}); skipping temp sweep`);
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
    await store.close();
  } catch (e) {
    console.warn(`error closing database: ${String(e)}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app.get("/healthz", (c) => c.text("ok"));

app.use("/public/*", serveStatic({ root: "./" }));

app.use("*", authMiddleware);

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
  fetch: app.fetch,
};
