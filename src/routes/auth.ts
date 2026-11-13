import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { APP_PASSWORD, COOKIE_SECURE, TRUST_PROXY } from "../config";
import { store } from "../db";
import { layout, esc } from "../ui";

export const auth = new Hono();

const COOKIE = "sess";
const LOGIN_COOKIE = "login_csrf";
const SESSION_MAX_AGE_SEC = 7 * 24 * 3600; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRACKED_IPS = 10_000;

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sessionSignature(id: string): string {
  return hmac(`sess.${id}`, APP_PASSWORD);
}

/** Stateless CSRF token derived from the session cookie. */
export function csrfTokenFor(sessionCookie: string): string {
  return hmac(`csrf.${sessionCookie}`, APP_PASSWORD);
}

/** CSRF token for this request's session cookie, or null when logged out. */
export function csrfFor(c: any): string | null {
  const sess = getCookie(c, COOKIE);
  return sess ? csrfTokenFor(sess) : null;
}

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(): Promise<string> {
  const id = newSessionId();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_SEC * 1000);
  // Store the hash, never the raw id: a DB leak must not hand out sessions.
  await store.run("INSERT INTO sessions(id, expires_at) VALUES(?, ?)", [
    sha256Hex(id),
    expires.toISOString(),
  ]);
  return `${id}.${sessionSignature(id)}`;
}

/** Returns the session id when valid, else null. */
export async function verifySession(value: string | undefined): Promise<string | null> {
  if (!APP_PASSWORD || !value) return null;
  const idx = value.lastIndexOf(".");
  if (idx === -1) return null;
  const id = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = sessionSignature(id);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (!timingSafeEqual(a, b)) return null;
  const now = new Date().toISOString();
  const row = await store.get1<{ expires_at: string }>(
    "SELECT expires_at FROM sessions WHERE id = ?",
    [sha256Hex(id)],
  );
  if (!row) return null;
  if (row.expires_at <= now) {
    await store.run("DELETE FROM sessions WHERE id = ?", [sha256Hex(id)]).catch(() => {});
    return null;
  }
  // Sliding renewal: an active session within 24 h of expiry gets the full
  // lifetime extended, so active users are not logged out mid-use; idle
  // sessions still expire on schedule.
  const remainingMs = Date.parse(row.expires_at) - Date.now();
  if (Number.isFinite(remainingMs) && remainingMs < 24 * 3600 * 1000) {
    const extended = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000).toISOString();
    await store
      .run("UPDATE sessions SET expires_at = ? WHERE id = ?", [extended, sha256Hex(id)])
      .catch(() => {});
  }
  return id;
}

export async function revokeSession(value: string | undefined): Promise<void> {
  if (!value) return;
  const idx = value.lastIndexOf(".");
  const id = idx === -1 ? value : value.slice(0, idx);
  if (/^[0-9a-f]{32}$/.test(id)) {
    await store.run("DELETE FROM sessions WHERE id = ?", [sha256Hex(id)]).catch(() => {});
  }
}

// In-memory per-IP login throttle. Persists for the process lifetime only;
// that is enough to blunt online password guessing without new deps.
const failedAttempts = new Map<string, { count: number; windowStart: number }>();

// A second layer for TRUST_PROXY=1 deployments, where an attacker can
// randomize X-Forwarded-For and defeat the per-IP throttle: once the whole
// process sees enough failures in the window, EVERY login attempt pays a
// fixed delay. Bounded and per-process — restarting resets it.
const GLOBAL_FAILURE_LIMIT = 20;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const GLOBAL_DELAY_MS = 400;
const globalFailures: number[] = [];

function pruneGlobalFailures(now: number): void {
  while (globalFailures.length > 0 && globalFailures[0] < now - GLOBAL_WINDOW_MS) {
    globalFailures.shift();
  }
}

function recordGlobalFailure(): void {
  const now = Date.now();
  pruneGlobalFailures(now);
  globalFailures.push(now);
}

function globalThrottleTripped(): boolean {
  pruneGlobalFailures(Date.now());
  return globalFailures.length >= GLOBAL_FAILURE_LIMIT;
}

function clientIp(c: Context): string {
  if (!TRUST_PROXY) {
    const env = c.env as { ip?: string } | undefined;
    return env?.ip || "unknown";
  }
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

function isLockedOut(ip: string): boolean {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOCKOUT_WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOCKOUT_WINDOW_MS) {
    if (!entry && failedAttempts.size >= MAX_TRACKED_IPS) {
      const oldest = failedAttempts.keys().next().value;
      if (oldest !== undefined) failedAttempts.delete(oldest);
    }
    failedAttempts.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count++;
}

function clearFailures(ip: string): void {
  failedAttempts.delete(ip);
}

function loginPage(error?: string, csrf?: string): string {
  const missing = !APP_PASSWORD
    ? `<p class="err-line">APP_PASSWORD is not set on the server. Sign-in is disabled.</p>`
    : "";
  return layout(
    "Sign in",
    `<form class="card login-card" method="post" action="/login">
      ${csrf ? `<input type="hidden" name="_csrf" value="${esc(csrf)}">` : ""}
      <label class="field">
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" autofocus>
      </label>
      ${missing}
      ${error ? `<p class="err-line">${esc(error)}</p>` : `<p class="muted">Enter the app password.</p>`}
      <button class="btn primary" type="submit">Sign in</button>
    </form>`,
  );
}

/** Render the login page with a fresh double-submit nonce + cookie. */
function loginResponse(
  c: Context,
  error: string | undefined,
  status: 200 | 401 | 403 | 429 = 200,
  headers?: Record<string, string>,
): Response {
  const nonce = newSessionId();
  setCookie(c, LOGIN_COOKIE, nonce, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "Lax",
    path: "/login",
    maxAge: 3600,
  });
  return c.html(loginPage(error, nonce), status, headers);
}

auth.get("/login", (c) => loginResponse(c, undefined));

auth.post("/login", async (c) => {
  const ip = clientIp(c);
  if (globalThrottleTripped()) {
    // Hold every attempt — including ones that look like a real user — so
    // distributed guessing cannot proceed faster than the delay allows.
    await new Promise((resolve) => setTimeout(resolve, GLOBAL_DELAY_MS));
  }
  if (isLockedOut(ip)) {
    console.warn(`login rate limit exceeded for ${ip}`);
    recordGlobalFailure();
    return loginResponse(c, "Too many failed attempts. Try again later.", 429, {
      "Retry-After": String(Math.ceil(LOCKOUT_WINDOW_MS / 1000)),
    });
  }
  const form = await c.req.formData();
  const suppliedNonce = String(form.get("_csrf") ?? "");
  const cookieNonce = getCookie(c, LOGIN_COOKIE) ?? "";
  if (!cookieNonce || !suppliedNonce || !safeEqual(suppliedNonce, cookieNonce)) {
    return loginResponse(c, "Session expired; try again.", 403);
  }
  deleteCookie(c, LOGIN_COOKIE, { path: "/login" });
  const supplied = String(form.get("password") ?? "");
  if (APP_PASSWORD && supplied && safeEqual(supplied, APP_PASSWORD)) {
    clearFailures(ip);
    await store.run("DELETE FROM sessions WHERE expires_at <= ?", [
      new Date().toISOString(),
    ]).catch(() => {});
    setCookie(c, COOKIE, await createSession(), {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return c.redirect("/");
  }
  recordFailure(ip);
  recordGlobalFailure();
  console.warn(`failed login attempt from ${ip}`);
  return loginResponse(c, "Wrong password", 401);
});

auth.post("/logout", async (c) => {
  await revokeSession(getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.redirect("/login");
});

export async function authMiddleware(
  c: any,
  next: () => Promise<void>,
): Promise<void | Response> {
  const path = new URL(c.req.url).pathname;
  if (path === "/healthz" || path === "/login" || path.startsWith("/public/")) {
    return next();
  }
  if (await verifySession(getCookie(c, COOKIE))) return next();
  // htmx/fetch callers get a 401 (so clients can tell "logged out" apart
  // from "redirected"); browsers keep the friendly redirect to /login.
  const accept = c.req.header("accept") ?? "";
  const isHtmx = c.req.header("hx-request") === "true";
  const wantsJson = accept.includes("application/json") || isHtmx;
  if (wantsJson) {
    return new Response("Unauthorized", { status: 401 });
  }
  return c.redirect("/login");
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Reject mutating requests whose CSRF token doesn't match the session. */
export async function csrfMiddleware(
  c: any,
  next: () => Promise<void>,
): Promise<void | Response> {
  if (!MUTATING.has(c.req.method)) return next();
  const path = new URL(c.req.url).pathname;
  if (path === "/login") return next();
  const sess = getCookie(c, COOKIE);
  if (!sess) {
    // authMiddleware should have rejected the request already; if it ever
    // doesn't (reorder/exemption), fail closed instead of letting a
    // token-less mutating request through.
    return new Response("Forbidden", { status: 403 });
  }
  const expected = csrfTokenFor(sess);
  let provided = c.req.header("x-csrf-token") ?? "";
  if (!provided) {
    const ct = c.req.header("content-type") ?? "";
    if (
      ct.includes("application/x-www-form-urlencoded") ||
      ct.includes("multipart/form-data")
    ) {
      // Hono caches the parsed body, so the handler's own formData() call
      // does not re-parse.
      const form = await c.req.formData().catch(() => null);
      provided = form ? String(form.get("csrf_token") ?? "") : "";
    }
  }
  if (provided && safeEqual(provided, expected)) return next();
  return new Response("Forbidden: invalid or missing CSRF token", { status: 403 });
}
