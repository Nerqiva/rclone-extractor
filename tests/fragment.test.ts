import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-fragment-"));
delete process.env.DATABASE_URL;

let app: Hono;

beforeAll(async () => {
  const db = await import("../src/db");
  await db.initDb();
  const { dashboard } = await import("../src/routes/dashboard");
  app = new Hono();
  app.route("/", dashboard);
});

test("/dashboard/fragment renders byte-identical HTML across identical polls", async () => {
  const r1 = await app.request("/dashboard/fragment");
  const r2 = await app.request("/dashboard/fragment");
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  // The client-side guard in the global script skips a polled swap whose
  // response matches the bytes already on the page; identical state must
  // therefore render identically. Running panels embed the elapsed timer
  // and differ by design.
  expect(await r1.text()).toBe(await r2.text());
});

test("fragment contains the idle panel", async () => {
  const res = await app.request("/dashboard/fragment");
  const body = await res.text();
  expect(body).toContain("No tasks yet");
});
