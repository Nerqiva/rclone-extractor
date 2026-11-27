import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

let parseCooldownSeconds: typeof import("../src/engine").parseCooldownSeconds;
let getSetting: typeof import("../src/db").getSetting;
let app: Hono;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-retry-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  parseCooldownSeconds = (await import("../src/engine")).parseCooldownSeconds;
  const db = await import("../src/db");
  await db.initDb();
  getSetting = db.getSetting;
  const { actions } = await import("../src/routes/actions");
  app = new Hono();
  app.route("/", actions);
});

test("retry cooldown parses strict whole seconds", () => {
  expect(parseCooldownSeconds("0")).toBe(0);
  expect(parseCooldownSeconds("60")).toBe(60);
  expect(parseCooldownSeconds("86400")).toBe(86400);
  expect(parseCooldownSeconds(" 15 ")).toBe(15);
  for (const bad of ["", " ", "1.5", "-1", "86401", "abc", "60s", null, undefined]) {
    expect(parseCooldownSeconds(bad)).toBeNull();
  }
});

test("config rejects an invalid retry cooldown and stores a valid one normalized", async () => {
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("60");

  const bad = new FormData();
  bad.append("retry_cooldown_seconds", "60.5");
  const badRes = await app.request("/config", { method: "POST", body: bad });
  expect(badRes.status).toBe(200);
  expect(await badRes.text()).toContain("retry_cooldown_seconds must be a whole number");
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("60");

  const good = new FormData();
  good.append("retry_cooldown_seconds", " 15 ");
  const goodRes = await app.request("/config", { method: "POST", body: good });
  expect(goodRes.status).toBe(200);
  expect((await getSetting("retry_cooldown_seconds", "60")) ?? "").toBe("15");
});
