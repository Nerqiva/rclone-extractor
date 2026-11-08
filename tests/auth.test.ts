import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-auth-"));
process.env.APP_PASSWORD = "test-pw";
delete process.env.DATABASE_URL;

let app: Hono;
let store: typeof import("../src/db").store;
let initDb: typeof import("../src/db").initDb;
let csrfTokenFor: typeof import("../src/routes/auth").csrfTokenFor;
let createSession: typeof import("../src/routes/auth").createSession;
let verifySession: typeof import("../src/routes/auth").verifySession;

beforeAll(async () => {
  const db = await import("../src/db");
  initDb = db.initDb;
  store = db.store;
  await initDb();

  const { auth, authMiddleware, csrfMiddleware, csrfTokenFor: csrf, createSession: create, verifySession: verify } =
    await import("../src/routes/auth");
  csrfTokenFor = csrf;
  createSession = create;
  verifySession = verify;

  app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", csrfMiddleware);
  app.route("/", auth);
  app.get("/protected", (c) => c.text("ok"));
  app.post("/echo", (c) => c.text("echoed"));
});

function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const m = /sess=([^;]+)/.exec(header);
  return m ? m[1] : "";
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=test-pw",
  });
  expect(res.status).toBe(302);
  const cookie = cookieFrom(res);
  expect(cookie).toBeTruthy();
  return { cookie, csrf: csrfTokenFor(cookie) };
}

test("protected page redirects when logged out", async () => {
  const res = await app.request("/protected");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("wrong password returns 401", async () => {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=nope",
  });
  expect(res.status).toBe(401);
});

test("login then logout revokes the session", async () => {
  const { cookie, csrf } = await login();

  const ok = await app.request("/echo", {
    method: "POST",
    headers: { Cookie: `sess=${cookie}`, "X-CSRF-Token": csrf },
  });
  expect(ok.status).toBe(200);

  const out = await app.request("/logout", {
    method: "POST",
    headers: { Cookie: `sess=${cookie}`, "X-CSRF-Token": csrf },
  });
  expect(out.status).toBe(302);

  // Old cookie must no longer work, even with its own valid CSRF token.
  const after = await app.request("/echo", {
    method: "POST",
    headers: { Cookie: `sess=${cookie}`, "X-CSRF-Token": csrf },
  });
  expect(after.status).toBe(302); // authMiddleware redirects to /login
});

test("POST without CSRF token is rejected", async () => {
  const { cookie } = await login();
  const res = await app.request("/echo", {
    method: "POST",
    headers: { Cookie: `sess=${cookie}` },
  });
  expect(res.status).toBe(403);
});

test("POST with wrong CSRF token is rejected", async () => {
  const { cookie } = await login();
  const res = await app.request("/echo", {
    method: "POST",
    headers: { Cookie: `sess=${cookie}`, "X-CSRF-Token": "deadbeef".repeat(8) },
  });
  expect(res.status).toBe(403);
});

test("plain form hidden csrf_token field is accepted", async () => {
  const { cookie, csrf } = await login();
  const res = await app.request("/echo", {
    method: "POST",
    headers: {
      Cookie: `sess=${cookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `csrf_token=${encodeURIComponent(csrf)}`,
  });
  expect(res.status).toBe(200);
});

test("logout-all revokes every session", async () => {
  const a = await login();
  const b = await login();

  const res = await app.request("/logout-all", {
    method: "POST",
    headers: { Cookie: `sess=${a.cookie}`, "X-CSRF-Token": a.csrf },
  });
  expect(res.status).toBe(302);

  for (const s of [a, b]) {
    expect(await verifySession(s.cookie)).toBeNull();
  }
});

test("expired session is rejected and removed", async () => {
  const sess = await createSession();
  const id = sess.slice(0, sess.lastIndexOf("."));
  await store.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    id,
  ]);
  expect(await verifySession(sess)).toBeNull();
  const row = await store.get1("SELECT id FROM sessions WHERE id = ?", [id]);
  expect(row).toBeNull();
});

test("login itself does not require a CSRF token", async () => {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=test-pw",
  });
  expect(res.status).toBe(302);
});
