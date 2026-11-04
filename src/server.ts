import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { BIND, PORT } from "./config";
import "./db";
import { auth, authMiddleware } from "./routes/auth";
import { pages } from "./routes/pages";
import { dashboard } from "./routes/dashboard";
import { actions } from "./routes/actions";
import { logsapi } from "./routes/logsapi";
import { data } from "./routes/data";

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

export default {
  port: PORT,
  hostname: BIND,
  fetch: app.fetch,
};

console.log(`rclone-extractor listening on http://${BIND}:${PORT}`);
