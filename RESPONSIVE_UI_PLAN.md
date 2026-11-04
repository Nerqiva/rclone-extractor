# Responsive UI/UX Plan - rclone-extractor

## Context

rclone-extractor: dark navy, JetBrains Mono, zero-radius cards, fixed left rail.
The visual identity fits the sysops audience. Scope is responsiveness only.
Every page usable from 320px wide up on touch and desktop, desktop layout unchanged >= 720px.

Pages: Dashboard (HTMX ring+bar+pills+controls), Config (form), Logs (table+pre),
Errors (table), Login (form, no rail). All server-rendered via HTMX/Hono.

## Approach

### Step 1 - HTML: rail toggle button and overlay (src/ui.ts)

1. In `rail()`: add `id="rail"` to the aside element.
2. In `layout()`: place the toggle button as a sibling of `${rail(active)}` (NOT inside the
   aside), so it stays pinned to the corner while the rail slides:

```html
<button class="rail-toggle" id="rail-toggle" aria-label="Toggle navigation" aria-controls="rail" aria-expanded="false">
  <span></span><span></span><span></span>
</button>
```

3. Immediately after the rail, add the backdrop div:

```html
<div class="rail-overlay" id="rail-overlay"></div>
```

4. The overlay is `display:none` on desktop and only clickable when the rail is open on mobile.

5. Add this inline script immediately before `</body>`, but ONLY when the rail is rendered
   (`active !== ""`) - it queries `#rail-toggle`, which does not exist on the login page:

```html
<script>
var btn = document.getElementById("rail-toggle");
var overlay = document.getElementById("rail-overlay");
var body = document.body;

function setRail(open) {
  body.classList.toggle("rail-open", open);
  btn.setAttribute("aria-expanded", String(open));
}

var isMobile = window.matchMedia("(max-width: 719px)").matches;
var stored = localStorage.getItem("rail-open");
setRail(isMobile ? false : stored !== "0");

btn.addEventListener("click", function () {
  setRail(!body.classList.contains("rail-open"));
  localStorage.setItem("rail-open", body.classList.contains("rail-open") ? "1" : "0");
});
overlay.addEventListener("click", function () {
  setRail(false);
});
</script>
```

6. `layout()` always renders the rail, so the login page shows nav links that redirect back to
   `/login`. Emit the rail only when `active !== ""`. The login call passes no `active`, so it
   gets no rail; every other page passes a key and is unchanged.
   With no rail, `.content` is the only flex child and fills the width. On mobile the extra
   `padding-top:60px` reserved for the toggle is harmless (centered card sits lower).

### Step 2 - CSS: toggle button, overlay, mobile layout (public/styles.css)

Insert the new rules from 2a and 2b at the anchors named there, then delete the existing
`@media (max-width: 720px)` block (lines 402-419) and replace it with 2c.

#### 2a. Toggle button and overlay base styles

Add after the `.rail-foot`/`.dot` rules (around line 130), before the `/* ---- content ---- */` comment:

```css
.rail-toggle {
  display: none;
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 200;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 9px;
  cursor: pointer;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.rail-toggle span {
  display: block;
  width: 16px;
  height: 2px;
  background: var(--text);
}
.rail-overlay {
  display: none;
}
```

#### 2b. Table scroll wrapper

Four-column tables overflow below ~380px. Add this rule immediately after the `table` rule
(after line 361, before `th,td`):

```css
.table-wrap {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

#### 2c. Replace the mobile block (lines 402-419)

Delete the existing `@media (max-width: 720px)` block and replace it with:

```css
@media (max-width: 719px) {
  .rail-toggle {
    display: flex;
  }
  .rail {
    position: fixed;
    left: -220px;
    top: 0;
    bottom: 0;
    width: 200px;
    z-index: 150;
    border-right: 1px solid var(--border);
    transition: left 0.2s ease;
    padding-top: 52px;
  }
  body.rail-open .rail {
    left: 0;
  }
  body.rail-open .rail-overlay {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 140;
    background: rgba(0, 0, 0, 0.55);
  }
  .content {
    padding: 60px 14px 48px;
  }
  .page-title {
    font-size: 18px;
    margin-bottom: 14px;
  }
  .statuscard {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 14px;
  }
  .statuscard .ring {
    justify-self: start;
    width: 96px;
    height: 96px;
  }
  th,
  td {
    padding: 7px 6px;
    font-size: 12px;
  }
  .tail {
    padding: 10px;
    font-size: 11px;
    max-height: 60vh;
  }
  .field-row {
    flex-direction: column !important;
    gap: 0 !important;
  }
  .card {
    padding: 14px;
  }
  .btn-row .btn {
    flex: 1 1 auto;
  }
  .login-card {
    max-width: 100%;
  }
}
```

Note: the ring SVG carries `width="132" height="132"` attributes; the CSS width/height above
overrides them while `viewBox="0 0 132 132"` scales the drawing. No markup change needed.

#### 2d. Touch ergonomics

Move these rules INTO the `@media (max-width: 719px)` block from 2c, before its closing brace.
16px font prevents iOS Safari auto-zoom on input focus:

```css
  input[type="text"],
  input[type="password"],
  input[type="number"],
  select,
  textarea {
    font-size: 16px;
  }
  .btn {
    min-height: 40px;
  }
```

#### 2e. Text contrast (accessibility)

Two tokens fail WCAG AA for normal text and are used for all secondary copy (hints, timestamps,
placeholders) - precisely the text a phone user leans on:

| token | current | contrast on `--panel` | change to | new contrast |
|---|---|---|---|---|
| `--muted` | `#6c7a99` | 3.20:1 | `#8fa0c0` | 5.22:1 |
| `--accent` | `#5b8cff` | 4.36:1 | `#6f9bff` | 5.12:1 |

Edit `:root` (lines 27-35) in place; both tokens are referenced only through `var()`, so no other
rule changes. The three `rgba(91, 140, 255, ...)` hover washes are decoration, not text - leave
them. `.btn.primary` sets `color:#0d1220` on the accent fill: 6.94:1 with the new accent, still
passing.

In the mobile block, also add `body.rail-open { overflow: hidden; }` so the page behind the
drawer does not scroll while the rail is open.

### Step 3 - Wrap tables in scroll containers

Four-column tables overflow below ~380px. Wrap each table literal in a `.table-wrap` div.
Two sites, both in src/routes/pages.ts:

1. `pages.ts:61-62` (Logs, "Previous runs" table): wrap the `<table>...</table>` literal.
2. `pages.ts:67-71` (Errors table): wrap the `<table>...</table>` literal.

The Errors `<tbody hx-get="/errors/fragment">` swaps `<tr>` rows only, so the wrapper around the
surrounding `<table>` in site 2 covers it.

### Step 4 - Center the login card (public/styles.css)

Replace `.login-card` rule (line ~164) with:

```css
.login-card {
  max-width: 360px;
  margin: 12vh auto 0;
}
With Step 1.6 the login page has no rail, so `margin: 12vh auto 0` centers the card both
horizontally and below the top edge. The reserved mobile `padding-top:60px` keeps it clear of
the viewport top.

### Step 5 - Add a sign-out control to the rail (src/ui.ts)

`POST /logout` exists (auth.ts:72) but nothing in the UI reaches it. In `rail()` append to
`.rail-foot`, after the `authed` label:

```html
<form method="post" action="/logout" class="rail-logout">
  <button class="btn" type="submit">Sign out</button>
</form>
```

`.rail-foot` is a flex row with `margin-top:auto`; add `padding-top:10px` and let the form sit at
the far right via `margin-left:auto`. On mobile the rail is a full-height drawer, so this is
reachable and correctly positioned.

Add to styles.css after the `.rail-foot` rule:

```css
.rail-logout {
  margin-left: auto;
}
.rail-logout .btn {
  padding: 3px 9px;
  font-size: 11px;
}
```

## Critical files and anchors

- `src/ui.ts:24-31` - `rail()`: aside id, hamburger button, sign-out form.
- `src/ui.ts:48-54` - `layout()`: overlay div and inline toggle script before closing body.
- `public/styles.css:113-130` - `.rail-foot`, `.dot`: anchor for new toggle/logout rules.
- `public/styles.css:402-419` - existing mobile media block: replace wholesale.
- `src/routes/pages.ts:57-72` - Logs and Errors table markup to wrap.

## Verification

Run from repo root so `/public/*` static serving resolves:

```
APP_PASSWORD=test DATA_DIR=/tmp/rx-data PORT=8099 bun run src/server.ts
```

1. `curl -s -o /dev/null -w "%{http_code}\n" localhost:8099/login` -> 200.
2. `curl -s -c /tmp/rx -d password=test localhost:8099/login` -> 302 to `/`.

3. Authenticated HTML contains the new chrome. With /tmp/rx from step 2:
   - `curl -s -b /tmp/rx localhost:8099/ | grep -c rail-toggle` -> 1
   - `curl -s -b /tmp/rx localhost:8099/ | grep -c rail-overlay` -> 1
   - `curl -s -b /tmp/rx localhost:8099/ | grep -c 'action="/logout"'` -> 1
4. CSS parses and serves: `curl -s -o /dev/null -w "%{http_code}\n" localhost:8099/public/styles.css`
   -> 200 and `curl -s localhost:8099/public/styles.css | grep -c 'rail-toggle'` -> 2+.

5. Visual proof in a real browser, at 1280x800 then 375x812 viewport:
   - Desktop: `.rail` visible at left; hamburger hidden (`display` -> `none`).
   - Mobile: hamburger visible (`display` -> `flex`); rail off-canvas (`left` -> `-220px`).
   - Tap hamburger: rail slides in (`left` -> `0`), overlay visible, `body.rail-open` set.
   - Tap overlay: rail slides out, `body.rail-open` removed.
   - `/logs` at 375px: table scrolls inside `.table-wrap`; page does not scroll sideways:
     `document.documentElement.scrollWidth <= 375` must be true.

6. Existing suite: `bun test` stays green (no test reads the HTML/CSS).

## Layout sketches

Desktop (>= 720px): the rail is the left column; content fills the rest.

Mobile (< 720px), rail closed: hamburger top-left, content full width.

## Assumptions

- Visual identity stays: dark palette, JetBrains Mono, zero-radius cards. Only responsiveness
  and the missing sign-out affordance change.
- Mobile query is `max-width: 719px` (the old block said 720; 719 avoids overlapping the
  half-pixel at 720 CSS px). The JS matchMedia string must be the identical `(max-width: 719px)`.
- The hamburger script is a plain inline `<script>`; the app has no CSP header and no bundler,
  so this needs no build step.
- localStorage persistence is desktop-only convenience; mobile always opens with the rail closed.
- `layout()` keeps its `(title, body, active)` signature; the rail/no-rail branch is internal.
- No new dependencies, fonts, or build step. Only `src/ui.ts`, `src/routes/pages.ts`, and
  `public/styles.css` change.
