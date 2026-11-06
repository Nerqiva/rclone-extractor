import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { APP_PASSWORD, BIND, PORT } from "./config";
import { initDb, store, getSetting } from "./db";
import { recoverStale } from "./engine";
import { checkRclone } from "./rclone";
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

const app = new Hono();

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
