import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getSetting } from "../db";
import { APP_PASSWORD } from "../config";
import { layout, esc } from "../ui";

export const auth = new Hono();

const COOKIE = "sess";

async function password(): Promise<string> {
  const stored = await getSetting("password", "");
  return stored || APP_PASSWORD;
}

function hmac(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export async function makeToken(): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${random}.${hmac(random, await password())}`;
}

export async function verifyToken(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const idx = value.lastIndexOf(".");
  if (idx === -1) return false;
  const random = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = hmac(random, await password());
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function loginPage(error?: string): string {
  return layout(
    "Sign in",
    `<form class="card login-card" method="post" action="/login">
      <label class="field">
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" autofocus>
      </label>
      ${error ? `<p class="err-line">${esc(error)}</p>` : `<p class="muted">Enter the app password.</p>`}
      <button class="btn primary" type="submit">Sign in</button>
    </form>`,
  );
}

auth.get("/login", (c) => c.html(loginPage()));

auth.post("/login", async (c) => {
  const form = await c.req.formData();
  const supplied = String(form.get("password") ?? "");
  if (supplied && supplied === (await password())) {
    setCookie(c, COOKIE, await makeToken(), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 604800,
    });
    return c.redirect("/");
  }
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
  return c.redirect("/login");
}
