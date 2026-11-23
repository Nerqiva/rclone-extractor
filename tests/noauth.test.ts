import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-noauth-"));
process.env.APP_PASSWORD = "";
delete process.env.DATABASE_URL;

let app: Hono;

beforeAll(async () => {
  await import("../src/db").then((db) => db.initDb());
  const { authMiddleware, csrfMiddleware } = await import("../src/routes/auth");
  app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", csrfMiddleware);
  app.get("/protected", (c) => c.text("ok"));
  app.post("/echo", (c) => c.text("echoed"));
});

test("empty APP_PASSWORD keeps the documented login-disabled mode usable", async () => {
  const get = await app.request("/protected");
  expect(get.status).toBe(200);
  expect(await get.text()).toBe("ok");
  const post = await app.request("/echo", { method: "POST" });
  expect(post.status).toBe(200);
  expect(await post.text()).toBe("echoed");
});
