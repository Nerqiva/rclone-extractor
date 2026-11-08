import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { APP_PASSWORD, COOKIE_SECURE } from "../config";
import { layout, esc } from "../ui";

export const auth = new Hono();

const COOKIE = "sess";
const SESSION_MAX_AGE_SEC = 7 * 24 * 3600; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function hmac(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Token: `<issued-at>.<random>.<hmac(payload)>`; verified for age on every request. */
export async function makeToken(): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const payload = `${Math.floor(Date.now() / 1000)}.${random}`;
  return `${payload}.${hmac(payload, APP_PASSWORD)}`;
}

export async function verifyToken(value: string | undefined): Promise<boolean> {
  if (!APP_PASSWORD || !value) return false;
  const idx = value.lastIndexOf(".");
  if (idx === -1) return false;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = hmac(payload, APP_PASSWORD);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // Payload must be `<unix-seconds>.<random>` and not older than the cookie max age.
  const dot = payload.indexOf(".");
  if (dot === -1) return false;
  const iat = Number(payload.slice(0, dot));
  if (!Number.isFinite(iat)) return false;
  const age = Math.floor(Date.now() / 1000) - iat;
  return age >= -300 && age <= SESSION_MAX_AGE_SEC;
}

// In-memory per-IP login throttle. Persists for the process lifetime only;
// that is enough to blunt online password guessing without new deps.
const failedAttempts = new Map<string, { count: number; windowStart: number }>();

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
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
    failedAttempts.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count++;
}

function clearFailures(ip: string): void {
  failedAttempts.delete(ip);
}

function loginPage(error?: string): string {
  const missing = !APP_PASSWORD
    ? `<p class="err-line">APP_PASSWORD is not set on the server. Login is disabled.</p>`
    : "";
  return layout(
    "Sign in",
    `<form class="card login-card" method="post" action="/login">
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

auth.get("/login", (c) => c.html(loginPage()));

auth.post("/login", async (c) => {
  const ip = clientIp(c);
  if (isLockedOut(ip)) {
    console.warn(`login rate limit exceeded for ${ip}`);
    return c.html(loginPage("Too many failed attempts. Try again later."), 429, {
      "Retry-After": String(Math.ceil(LOCKOUT_WINDOW_MS / 1000)),
    });
  }
  const form = await c.req.formData();
  const supplied = String(form.get("password") ?? "");
  if (APP_PASSWORD && supplied && safeEqual(supplied, APP_PASSWORD)) {
    clearFailures(ip);
    setCookie(c, COOKIE, await makeToken(), {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    });
    return c.redirect("/");
  }
  recordFailure(ip);
  console.warn(`failed login attempt from ${ip}`);
  return c.html(loginPage("Wrong password"), 401);
});

auth.post("/logout", (c) => {
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
  if (await verifyToken(getCookie(c, COOKIE))) return next();
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
