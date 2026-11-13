import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createHash } from "node:crypto";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

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

async function loginForm(): Promise<{ nonce: string; cookie: string }> {
  const res = await app.request("/login");
  expect(res.status).toBe(200);
  const body = await res.text();
  const cookieHeader = res.headers.get("set-cookie") ?? "";
  const m = /login_csrf=([^;]+)/.exec(cookieHeader);
  const nonce = /name="_csrf" value="([^"]+)"/.exec(body);
  return { nonce: nonce ? nonce[1] : "", cookie: m ? m[1] : "" };
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const { nonce, cookie: csrfCookie } = await loginForm();
  expect(nonce).toBeTruthy();
  const res = await app.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `login_csrf=${csrfCookie}`,
    },
    body: `password=test-pw&_csrf=${encodeURIComponent(nonce)}`,
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
  const { nonce, cookie: csrfCookie } = await loginForm();
  const res = await app.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `login_csrf=${csrfCookie}`,
    },
    body: `password=nope&_csrf=${encodeURIComponent(nonce)}`,
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

test("expired session is rejected and removed", async () => {
  const sess = await createSession();
  const id = sess.slice(0, sess.lastIndexOf("."));
  await store.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    sha256(id),
  ]);
  expect(await verifySession(sess)).toBeNull();
  const row = await store.get1("SELECT id FROM sessions WHERE id = ?", [sha256(id)]);
  expect(row).toBeNull();
});

test("login without the double-submit nonce is rejected", async () => {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=test-pw",
  });
  expect(res.status).toBe(403);
});

test("login with a mismatched nonce is rejected", async () => {
  const { cookie: csrfCookie } = await loginForm();
  const res = await app.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `login_csrf=${csrfCookie}`,
    },
    body: "password=test-pw&_csrf=deadbeef",
  });
  expect(res.status).toBe(403);
});

test("an active session close to expiry is renewed (sliding)", async () => {
  const sess = await createSession();
  const id = sess.slice(0, sess.lastIndexOf("."));
  const soon = new Date(Date.now() + 12 * 3600 * 1000).toISOString(); // 12h left
  await store.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [soon, sha256(id)]);
  expect(await verifySession(sess)).toBe(id);
  const row = await store.get1<{ expires_at: string }>(
    "SELECT expires_at FROM sessions WHERE id = ?",
    [sha256(id)],
  );
  expect(Date.parse(row?.expires_at ?? "")).toBeGreaterThan(
    Date.now() + 6 * 24 * 3600 * 1000,
  );
});

test("global failure threshold delays subsequent login attempts", async () => {
  for (let i = 0; i < 20; i++) {
    const { nonce, cookie } = await loginForm();
    await app.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `login_csrf=${cookie}`,
      },
      body: `password=nope-${i}&_csrf=${encodeURIComponent(nonce)}`,
    });
  }
  const { nonce, cookie } = await loginForm();
  const start = Date.now();
  await app.request("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `login_csrf=${cookie}`,
    },
    body: `password=nope-final&_csrf=${encodeURIComponent(nonce)}`,
  });
  expect(Date.now() - start).toBeGreaterThanOrEqual(350);
});
