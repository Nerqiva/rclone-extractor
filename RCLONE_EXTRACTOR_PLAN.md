# rclone-extractor — Simple Build Plan

A small web app that scans an rclone remote for archives, extracts them in place,
moves the results up, and trashes the archive. It has a dashboard, a config page,
and log/error pages.

This plan is written for small / mid-tier coding models (e.g. MiniMax). Every
rule below exists to stop the model getting confused, editing the same file over
and over, or running commands that error out.

---

## 0. Rules for the building model (read every session)

1. **One language only: TypeScript run by Bun.** No Rust, no Python, no npm build
   step, no bundler, no framework JS on the client.
2. **Regenerate whole files with the `write` tool.** Do not do 20 tiny `edit`
   calls on a file. If a file needs more than a small fix, rewrite it completely.
3. **Build only the segment you were told to build.** Do not touch files owned by
   another segment. There are no stubs for future segments.
4. **Run the segment's *Verify* command yourself** and paste the real output.
   Do not claim success without running it.
5. **If a command errors, read the error, fix the one cause, re-run.** Do not
   retry blindly and do not re-plan.
6. **Add nothing to `package.json` unless the segment says so.** Bun's built-ins
   (`bun:sqlite`, `Bun.spawn`, `Bun.file`, `Bun.write`) replace most libraries.
7. **Never run `bun install` unless a segment says so.** Only Hono and htmx exist.
8. **Keep every file under ~150 lines.** If a file grows past that, split it.

---

## 1. Stack (fixed — add nothing)

| Need | Choice | Why |
|---|---|---|
| Runtime | Bun 1.4.x | Runs TS directly, no build step |
| HTTP | Hono 4.x | Tiny, Web-standard, easy for models |
| Database | `bun:sqlite` (built-in) | Synchronous, zero deps |
| Child processes | `Bun.spawn` (built-in) | Run rclone, capture output |
| Files | `Bun.file`, `Bun.write` (built-in) | Read/write/stream files |
| UI | htmx 2.0.11, one vendored file | Server-rendered fragments, no JS app |
| Styling | one `styles.css` file | No Tailwind, no build |
| Auth | signed cookie, `Bun.CryptoHasher` (built-in) | No crypto library |
| Tests | `bun test` (built-in) | Zero deps |

**Explicitly NOT used:** Rust, axum, askama, tokio, SSE, WebSockets, React, Vue,
Tailwind, a bundler, a template engine, npm packages beyond Hono.

### Why htmx polling instead of SSE

The dashboard and logs refresh with `hx-trigger="every 1s"` fetching an HTML
fragment. No event stream, no reconnection logic, no client JS. At 1 second
granularity this is instant enough for a human watching a job run.

### Dependency list (final, `package.json`)

```json
{
  "name": "rclone-extractor",
  "type": "module",
  "scripts": { "start": "bun run src/server.ts", "test": "bun test" },
  "dependencies": { "hono": "^4.9.0" },
  "devDependencies": { "@types/bun": "latest" }
}
```

htmx is a single vendored file at `public/htmx.min.js` (downloaded once in S1).
No other npm package is allowed.

---

## 2. File map (who owns what)

```
src/
  server.ts      S1  entry: config, db, routes wiring, listen
  config.ts      S1  env + paths
  db.ts          S1  open DB, schema, settings helpers
  log.ts         S1  file logger
  rclone.ts      S2  run rclone commands
  archive.ts     S2  name/path helpers + isSupported
  engine.ts      S3  the extract loop + cancel
  ui.ts          S4  HTML layout + shared fragments (escaping helper)
  routes/
    pages.ts     S4  GET /  /config  /logs  /errors
    auth.ts      S4  GET/POST /login  POST /logout  + middleware
    dashboard.ts S5  GET /dashboard/fragment  (htmx poll target)
    actions.ts   S5  POST /run/start  /run/stop  /config  /rclone-conf
    logsapi.ts   S6  GET /logs/fragment  /errors/fragment  + downloads
    data.ts      S7  POST /export  POST /import
public/
  styles.css     S4  design system (owned by S4, later segments reuse)
  htmx.min.js    S1  vendored htmx (downloaded, never edited)
data/            S1  created at runtime; app.db + logs/ live here
rclone.conf      optional, user-supplied
package.json     S1
Dockerfile       S8
.dockerignore    S8
```

Each segment lists exactly the files it may write. Nothing else.

---

## 3. Shared contracts (all segments depend on these — never change)

### 3.1 Config (`src/config.ts`)

```ts
export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const DB_PATH = `${DATA_DIR}/app.db`;
export const LOG_DIR = `${DATA_DIR}/logs`;
export const BIND = process.env.BIND ?? "0.0.0.0";
export const PORT = Number(process.env.PORT ?? 8080);
export const APP_PASSWORD = process.env.APP_PASSWORD ?? ""; // fallback only
```

`APP_PASSWORD` is only used on first init to seed `settings.password`.

### 3.2 Database (`src/db.ts`)

SQLite file `data/app.db`. Created in S1, **never altered after**.

```sql
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)

archives(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,        -- relative to scan_root, no leading slash
  size INTEGER NOT NULL,
  status TEXT NOT NULL,             -- queued|extracting|done|failed|skipped
  error_kind TEXT,                  -- null|"extract"|"password"|"spawn"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL)

runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0)

logs(
  archive_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- rclone|extract
  rel_path TEXT NOT NULL,
  PRIMARY KEY(archive_id, kind))
```

Also: `PRAGMA journal_mode=WAL;`

Exported helpers (exact names — later segments call these):

```ts
export const db = new Database(DB_PATH, { create: true });
export function getSetting(key: string, fallback?: string): string | undefined;
export function setSetting(key: string, value: string): void;   // upsert
export function allSettings(): Record<string, string>;
```

### 3.3 Settings keys (all TEXT)

`scan_root`, `remote_flags`, `queue_max` (default "500"),
`sort_by` (`path|size`), `sort_dir` (`asc|desc`), `dry_run` (`0|1`),
`trash_subdir` (default "trash"), `password`, `cancel` (`0|1`).
Seeded with defaults in S1.

### 3.4 Log files (`data/logs/`)

```
run-<runid>-<timestamp>.log          main log
run-<runid>-<timestamp>-errors.log   detailed errors
archive-<archiveid>-rclone.log       raw rclone output for one archive
archive-<archiveid>-extract.log      raw extract output for one archive
```

Line format: `<ISO timestamp> <LEVEL> <message>`.
A warn/error detail block is wrapped in a line of 72 dashes above and below.

### 3.5 Routes (fixed)

```
GET  /                     dashboard page            (auth)
GET  /config               config page               (auth)
GET  /logs                 logs page                 (auth)
GET  /errors               errors page               (auth)
GET  /login  POST /login  POST /logout

GET  /dashboard/fragment   htmx: status card, polls every 1s   (auth)
GET  /logs/fragment        htmx: live tail of current run log  (auth)
GET  /errors/fragment      htmx: error table rows              (auth)

POST /run/start            start a run               (auth)
POST /run/stop             cancel current run        (auth)
POST /config               save settings             (auth)
POST /rclone-conf          upload rclone.conf        (auth)

GET  /download/run/:id          download a run log
GET  /download/archive/:id      download an archive log (?kind=extract|rclone)

POST /export  POST /import

GET  /healthz              returns "ok" (no auth)
GET  /public/*             static files (no auth)
```

### 3.6 rclone command shapes (exact — do not invent flags)

```
list:    rclone lsf <ROOT> --recursive --files-only --format ps --separator ";"
extract: rclone archive extract <ROOT>/<REL> <ROOT>/<TMPREL> --stats 1s --stats-one-line
promote: rclone move <ROOT>/<TMPREL> <ROOT>/<PARENT> --delete-empty-src-dirs
cleanup: rclone purge <ROOT>/<TMPREL>
trash:   rclone moveto <ROOT>/<REL> <ROOT>/<trash_subdir>/<REL>
```

`<PARENT>` is the directory part of `<REL>`. `<TMPREL>` is
`.rclone-extractor-tmp/<runid>/<stem>` where `<stem>` is the file name with its
archive suffix removed.

`remote_flags` (a settings string) is split on whitespace and appended to every
command. When `dry_run=1`, `--dry-run` is appended to extract/promote/cleanup/trash.

Implement rclone calls with `Bun.spawn`:

```ts
const proc = Bun.spawn(["rclone", ...args], { stdout: "pipe", stderr: "pipe" });
const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
const code = await proc.exited;
```

### 3.7 Auth contract (S4)

- One signed cookie named `sess`.
- Token value = `<random_hex>.<hmac_hex>`, where
  `hmac = CryptoHasher("sha256", settings.password).update(random_hex)`.
- Login checks the cookie HMAC in constant time, then accepts.
- Cookie options: `httpOnly: true, sameSite: "Lax", path: "/", maxAge: 604800`.
- `authMiddleware` runs on every route except `/healthz`, `/login`, `/public/*`.
- No session store: validity is proven by the HMAC, so a restart does not log
  anyone out. This removes the in-memory session-set complexity entirely.

### 3.8 HTML escaping (S4 owns; everyone uses it)

`src/ui.ts` exports:

```ts
export function esc(s: unknown): string;   // & < > " ' escaped
export function layout(title: string, body: string): string; // full page w/ rail
```

Any value interpolated into HTML must pass through `esc()`. This is the only
XSS guard and it is mandatory.

### 3.9 Design tokens (`public/styles.css`, owned by S4 — reuse everywhere)

Built using the **frontend-design** skill. Direction: a "terminal logbook" look
for a sysadmin tool — dark, dense, monospaced where data matters, calm, no
decoration.

```
bg        #1C2333     panel    #242D40     border   #2E3A52
text      #CDD6F4     muted    #6C7A99
accent    #5B8CFF     ok       #4ADE80
warn      #FACC15     err      #F87171

Type:    JetBrains Mono 400/500/600, self-hosted woff2 (fallback monospace)
Scale:   11px labels, 13px body, 16px section titles, 22px page title
Layout:  200px left rail, content max-width 1100px, left aligned
Radius:  4px inputs, 999px pills, 0 everywhere else
No shadows, no gradients. 1px borders do the separating.
```

The rail has four links: Dashboard, Configuration, Logs, Errors. The active link
gets the accent colour. Right side of the rail shows a small password/status dot.

---

## 4. Segments

Each segment: **files**, **what to build**, **the exact code shape**, **verify**.
Work one segment per session. Around 12 segments — small enough to fit a 131K
context with room to spare.

---

### S1 — Project skeleton, config, database, logger

**Files:** `package.json`, `src/config.ts`, `src/db.ts`, `src/log.ts`,
`src/server.ts`, `public/htmx.min.js`

**Build**

1. `package.json` exactly as in section 1.
2. `bun install` once (installs Hono + Bun types).
3. Download htmx once:
   `curl -L https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js -o public/htmx.min.js`
4. `src/config.ts` — exactly section 3.1. Also create `DATA_DIR`, `LOG_DIR`, and
   `public/` at import time using `node:fs` `mkdirSync(..., { recursive: true })`.
5. `src/db.ts` — open the DB, `exec` the schema from section 3.2, seed defaults
   with `INSERT OR IGNORE`, export `db`, `getSetting`, `setSetting`, `allSettings`.
   Defaults: `queue_max=500`, `sort_by=path`, `sort_dir=asc`, `dry_run=0`,
   `trash_subdir=trash`, `cancel=0`, `remote_flags=""`, and `scan_root`,
   `password` seeded from env if present.
6. `src/log.ts` — a `Logger` class:

```ts
export class Logger {
  constructor(private file: string) {}
  info(msg: string): void;   // appends "<iso> INFO <msg>\n"
  warn(msg: string): void;   // "<iso> WARN <msg>\n"
  error(msg: string, detail?: string): void; // ERROR + 72-dash detail block
}
export function logPath(name: string): string; // LOG_DIR + "/" + name
```

   Append with `node:fs` `appendFileSync` (Bun.write replaces whole files, which
   is not what a log needs).

7. `src/server.ts` — minimal Hono app with only:
   `/healthz` -> `c.text("ok")`, and a `/public/*` static handler using Hono's
   `serveStatic({ root: "./" })`. Listen on `PORT`/`BIND`.

**Verify**

```bash
bun install
bun run src/server.ts &   # leave running
sleep 1
curl -s localhost:8080/healthz          # prints: ok
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/public/htmx.min.js  # 200
kill %1
ls data/app.db data/logs public/htmx.min.js   # all exist
```

---

### S2 — Archive helpers and rclone wrapper

**Files:** `src/archive.ts`, `src/rclone.ts`, `tests/s2.test.ts`

**Build**

1. `src/archive.ts` — pure functions, no I/O, no imports:

```ts
export function isSupported(name: string): boolean;
// lowercase endsWith one of:
// .zip .tar .tar.gz .tgz .taz .tar.bz2 .tb2 .tbz .tbz2 .tz2 .tar.lz
// .tar.lz4 .tar.xz .txz .tar.zst .tzst .tar.br .tar.sz .tar.mz
// (.sqfs is NOT supported)

export function stem(name: string): string;            // filename minus archive suffix
export function parentRel(rel: string): string;         // dirname, "" at root
export function tmpRel(rel: string, runId: number): string;
//   ".rclone-extractor-tmp/" + runId + "/" + stem(name)
export function trashRel(rel: string, subdir: string): string; // subdir + "/" + rel
```

2. `src/rclone.ts`:

```ts
export type Outcome = { code: number; tail: string[]; stderr: string };

export class Rclone {
  constructor(public bin: string, public root: string, public flags: string[]) {}
  static fromSettings(): Rclone;   // reads scan_root (fallback "") and remote_flags

  async list(onFile: (rel: string, size: number) => void): Promise<void>;
  // runs: lsf ... --separator ";"
  // for each stdout line: split on last ";" -> [path, size]
  //   path may start with "./" -> strip it
  //   skip if !isSupported(name); else onFile(rel, Number(size))

  async run(args: string[], dry: boolean, logFile: string): Promise<Outcome>;
  // args already include the subcommand; this method:
  //   appends this.flags; appends "--dry-run" if dry
  //   spawns bin; reads stdout+stderr
  //   appends every line to logFile as "<iso> <line>" via appendFileSync
  //   tail = last 40 lines of combined output

  extract(rel: string, tmp: string, dry: boolean, logFile: string): Promise<Outcome>;
  promote(rel: string, tmp: string, dry: boolean, logFile: string): Promise<Outcome>;
  cleanup(tmp: string, dry: boolean, logFile: string): Promise<Outcome>;
  trash(rel: string, subdir: string, dry: boolean, logFile: string): Promise<Outcome>;
}
```

   Build the exact arg arrays from section 3.6. Do not add `--progress` or any
   flag not listed.

**Verify** (`tests/s2.test.ts` using `bun test`)

```ts
import { test, expect } from "bun:test";
import { isSupported, tmpRel, parentRel, stem } from "../src/archive";

test("supported", () => {
  expect(isSupported("a.zip")).toBe(true);
  expect(isSupported("a.tar.zst")).toBe(true);
  expect(isSupported("x.rar")).toBe(false);
  expect(isSupported("y.sqfs")).toBe(false);
});
test("paths", () => {
  expect(stem("dir/a.tar.gz")).toBe("a");
  expect(parentRel("dir/a.zip")).toBe("dir");
  expect(parentRel("a.zip")).toBe("");
  expect(tmpRel("dir/a.zip", 7)).toBe(".rclone-extractor-tmp/7/a");
});
```

Run `bun test`. All tests pass. (The rclone spawn path is exercised in S3.)

---

### S3 — The engine

**Files:** `src/engine.ts`, `tests/s3.test.ts`

**Build**

```ts
import { Logger, logPath } from "./log";
import { db, getSetting, setSetting } from "./db";
import { Rclone } from "./rclone";

// module-level run state, read by the UI:
export const engineState = {
  running: false,
  runId: 0,
  stage: "idle",       // idle|searching|listing|queueing|extracting|finished|error
  currentRel: "",
  total: 0, done: 0, failed: 0, skipped: 0,
  lastError: "",
};

export async function runEngine(): Promise<void>;   // full loop
export function stopEngine(): void;                 // sets settings cancel=1
```

`runEngine` steps, strictly sequential (no parallel jobs):

1. If `engineState.running` return. Set `running=true`, clear `lastError`.
2. Read settings. `scan_root` empty -> stage `error`,
   `lastError="scan_root not set"`, return.
3. Create a `runs` row (`started_at = now`), remember `runId` and its log file name
   `run-<runId>-<timestamp>.log`; open its `Logger`.
4. stage `searching`; then `listing`: `rclone.list(...)` inserts each file as
   `queued` with `INSERT OR IGNORE` (path is UNIQUE). Stop after `queue_max`.
5. stage `queueing`: select queued rows ordered by `sort_by`/`sort_dir`; set
   `runs.total`; update `engineState.total`.
6. stage `extracting`; for each queued row (re-check `cancel` setting at the top
   of each iteration):
   - set row `status=extracting`, `updated_at=now`; set `engineState.currentRel`.
   - `extract` into `tmp`; write raw output to `archive-<id>-extract.log`,
     link via `logs` table (`kind='extract'`).
   - on non-zero exit:
     - if output contains `password` (case-insensitive): row
       `status=skipped, error_kind=password`; one `warn` line; continue.
     - else: `cleanup` tmp; row `status=failed, error_kind=extract`; one `error`
       line in the main log plus the 72-dash detail block; continue.
   - `promote` tmp into parent; then `cleanup` tmp.
   - `trash` the original file into `trash_subdir`.
   - row `status=done`; increment `done`.
   - update `runs.done/failed/skipped` and `engineState` counters each item.
7. stage `finished`; `runs.finished_at = now`; `running=false`.

Wrap the whole loop in try/catch: on unexpected throw set
`lastError = String(e)`, `stage="error"`, `running=false`, and still close the
`runs` row.

`stopEngine` just calls `setSetting("cancel","1")`. The loop clears it at the
start of each run.

**Verify** (`tests/s3.test.ts`)

Make a fake `rclone` shell script in a temp dir that:
- on `lsf` prints `./a/b.zip;1000` and `./a/c.zip;1000`
- on `archive extract` for `b.zip` exits 0; for `c.zip` writes `password required`
  to stderr and exits 1

Point settings `scan_root` at a temp dir, prepend the temp bin dir to `PATH`,
then in the test call `runEngine()` and assert:
- `archives` has one `done` and one `skipped` (error_kind `password`)
- `engineState.done === 1`, `engineState.skipped === 1`.

Run `bun test`. Both S2 and S3 tests pass.

---

### S4 — Shell: layout, CSS, auth, page routes

**Files:** `src/ui.ts`, `src/routes/pages.ts`, `src/routes/auth.ts`,
`public/styles.css`, update `src/server.ts`

**Build**

1. `src/ui.ts`:
   - `esc(s)` and `layout(title, body)` from section 3.8.
   - `layout` returns a full HTML document: `<head>` links `/public/styles.css`
     and `/public/htmx.min.js` (with `defer`), `<body>` = 200px left rail
     (Dashboard / Configuration / Logs / Errors links + status dot) plus
     `<main>` containing `body`.
   - `rail(active)` builds the nav; highlight `active`.
2. `public/styles.css` — the design tokens and component styles from section 3.9.
   Use the **frontend-design** skill to make it genuinely good: pick the
   logbook direction, set the type scale, style the rail, cards, tables, forms,
   buttons, pills, the progress bar and the ring. Self-host JetBrains Mono woff2
   under `public/fonts/` (three @font-face rules, weights 400/500/600).
   Add a `prefers-reduced-motion` block and a visible `:focus-visible` outline.
3. `src/routes/auth.ts`:
   - `makeToken()`, `verifyToken(cookieValue)` using `Bun.CryptoHasher` and
     `crypto.getRandomValues` for randomness; compare with a constant-time helper.
   - `GET /login` -> login page (a plain form posting to `/login`, error line slot).
   - `POST /login` -> read form field `password`; if it equals
     `getSetting("password")` (or `APP_PASSWORD` when unset), `setCookie` and
     redirect `/`; else re-render login with `Wrong password`.
   - `POST /logout` -> `deleteCookie`, redirect `/login`.
   - `authMiddleware`: if path is `/healthz`, `/login`, or starts with `/public/`,
     skip; else require a valid `sess` cookie, else redirect to `/login`.
4. `src/routes/pages.ts`: `GET /`, `/config`, `/logs`, `/errors` each return
   `c.html(layout(...))` with a placeholder body for now (real bodies land in
   S5/S6). This proves the shell and auth work end to end.
5. `src/server.ts`: mount `authMiddleware`, `/public/*` (serveStatic), `/healthz`,
   the auth routes, and the page routes.

**Verify**

```bash
bun run src/server.ts &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/login          # 200
curl -s -o /dev/null -w "%{http_code}\n" -L localhost:8080/             # 200 (after redirect)
curl -s -o /dev/null -w "%{http_code}\n" -L -d "password=wrong" localhost:8080/login  # 200, body has "Wrong password"
curl -s -c /tmp/c.txt -d "password=$APP_PASSWORD" localhost:8080/login >/dev/null
curl -s -b /tmp/c.txt -o /dev/null -w "%{http_code}\n" localhost:8080/ # 200
kill %1
```

Also open `/login` in a browser and confirm the page looks intentional.

---

### S5 — Dashboard fragment and actions

**Files:** `src/routes/dashboard.ts`, `src/routes/actions.ts`,
update `src/routes/pages.ts` (dashboard body only), update `src/server.ts`

**Build**

1. `src/routes/dashboard.ts` — `GET /dashboard/fragment` returns an HTML fragment
   (no layout, just the inner HTML) built from `engineState`:

```
<div class="statuscard">
  <div class="bar"><div class="bar-fill" style="width: N%"></div></div>
  <svg class="ring"><circle .../></svg>   // r=52, dasharray=2*pi*r, dashoffset by pct
  <p class="stage">stage text</p>
  <p class="current" title="full path">current archive name</p>
  <span class="pill ok">done N</span>
  <span class="pill err">failed N</span>
  <span class="pill warn">skipped N</span>
  <p class="err-line">last error, if any</p>
</div>
```

   Colour the bar and ring with a state class (`is-running`, `is-done`,
   `is-error`) so the CSS handles colours, not inline JS.
2. `src/routes/pages.ts` — replace the dashboard placeholder body with:

```html
<div hx-get="/dashboard/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML"></div>
<div id="controls">
  <form hx-post="/run/start" hx-target="#controls" hx-swap="outerHTML">button Start</form>
</div>
```

   Keep the controls as their own fragment so Start/Stop swap cleanly.
3. `src/routes/actions.ts`:
   - `POST /run/start` -> if `!engineState.running`,
     `db.exec("UPDATE archives SET status='queued' WHERE status='failed'")`,
     reset `cancel=0`, then `void runEngine()` (do not await), return the swapped
     controls fragment showing a Stop button.
   - `POST /run/stop` -> `stopEngine()`, return the controls fragment showing Start.
   - `POST /config` -> read all settings keys from the form (`dry_run` is a
     checkbox: present = "1", absent = "0"), `setSetting` each, return the config
     form fragment with a "Saved" note.
   - `POST /rclone-conf` -> write `DATA_DIR/rclone.conf` from `await c.req.text()`,
     return a small "Uploaded" fragment.

**Verify**

```bash
# with the fake rclone from S3 on PATH, and scan_root pointed at test archives
bun run src/server.ts &
sleep 1
# log in first (see S4), keep the cookie jar
curl -s -b /tmp/c.txt localhost:8080/dashboard/fragment | head -5   # returns the statuscard HTML
curl -s -b /tmp/c.txt -X POST localhost:8080/run/start              # returns Stop controls
sleep 2
curl -s -b /tmp/c.txt localhost:8080/dashboard/fragment | grep -o 'pill ok' # present after done
kill %1
```

Then open `/` in a browser: press Start and watch the bar, ring, stage text and
counters update without a page reload.

---

### S6 — Logs page, errors page, live log tail, downloads

**Files:** `src/routes/logsapi.ts`, update `src/routes/pages.ts`,
update `src/server.ts`

**Build**

1. `GET /logs/fragment` — find the newest `run-*.log` in `LOG_DIR`; return the
   last 200 lines as `<pre class="tail">…</pre>` (escaped). If none, return an
   empty-state message.
2. `GET /errors/fragment` — `SELECT id, path, error_kind, updated_at FROM archives
   WHERE error_kind IS NOT NULL ORDER BY updated_at DESC`; render as table rows,
   each with a download link `/download/archive/<id>?kind=extract`.
3. `src/routes/pages.ts`:
   - Logs page body: a `<div hx-get="/logs/fragment"
     hx-trigger="load, every 1s" hx-swap="innerHTML"></div>` plus a list of
     previous run log files (name, mtime, download link).
   - Errors page body: a table whose `<tbody>` has
     `hx-get="/errors/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML"`.
4. Downloads:
   - `GET /download/run/:id` — locate the run log file for that run id, stream it
     with `Bun.file(path)` and `Content-Disposition: attachment`.
   - `GET /download/archive/:id` — read `?kind=` (`extract` default, or `rclone`),
     look up `logs` table, stream that file. If missing, return 404 text.

**Verify**

```bash
# run the fake-rclone job so one archive fails
curl -s -b /tmp/c.txt -X POST localhost:8080/run/start >/dev/null
sleep 2
curl -s -b /tmp/c.txt localhost:8080/logs/fragment    | head -3    # tail lines present
curl -s -b /tmp/c.txt localhost:8080/errors/fragment  | grep -o 'download/archive'  # a link
curl -s -b /tmp/c.txt -o /tmp/e.log localhost:8080/download/archive/2?kind=extract
grep -i password /tmp/e.log       # the failed archive's raw output is there
```

---

### S7 — Export / import

**Files:** `src/routes/data.ts`, update `src/routes/pages.ts` (buttons),
update `src/server.ts`

**Build**

1. `POST /export` — first `db.exec("PRAGMA wal_checkpoint(FULL)")`, then write
   `settings.json` (from `allSettings()`), then spawn

```ts
const p = Bun.spawn(["tar","czf","-","-C",DATA_DIR,"app.db","logs","settings.json"]);
return new Response(p.stdout, {
  headers: { "Content-Type": "application/gzip",
             "Content-Disposition": `attachment; filename=export-${Date.now()}.tar.gz` }
});
```

   If the form field `include_rclone` is set and `rclone.conf` exists, add
   `rclone.conf` to the tar argument list. The spawn fallback is preferred over
   any archiving library — it always works.
2. `POST /import` — accept a multipart file `archive`. Copy the current DB to
   `app.db.bak`, extract the upload into a temp dir with `tar xzf`, replace
   `app.db` and `logs/`, and apply `settings.json`. Use `await c.req.formData()`
   then `Bun.write(temp, file)`. Return a fragment reporting what was imported.

**Verify**

```bash
curl -s -b /tmp/c.txt -o /tmp/exp.tar.gz -X POST localhost:8080/export -d "include_rclone=1"
tar tzf /tmp/exp.tar.gz | head    # shows app.db, logs/..., settings.json
curl -s -b /tmp/c.txt -o /dev/null -w "%{http_code}\n" -F "archive=@/tmp/exp.tar.gz" localhost:8080/import  # 200
ls data/app.db.bak                 # backup created
```

---

### S8 — Dockerfile and CI

**Files:** `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`

**Build**

`Dockerfile` — one final stage:

```dockerfile
FROM oven/bun:1.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tar gzip \
 && curl -LO https://downloads.rclone.org/rclone-current-linux-amd64.zip \
 && unzip rclone-current-linux-amd64.zip \
 && cp rclone-*-linux-amd64/rclone /usr/local/bin/ \
 && chmod 755 /usr/local/bin/rclone \
 && rm -rf rclone-* \
 && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
USER bun
CMD ["bun","run","src/server.ts"]
```

`.dockerignore`: `node_modules`, `data`, `.git`, `*.md`.

`.github/workflows/ci.yml` — on push to main and tags `v*`:
run `bun install --frozen-lockfile`, `bun test`, then
`docker buildx build --platform linux/amd64,linux/arm64 --push` to
`ghcr.io/${{ github.repository }}:latest` and `:${{ github.sha }}`.
Permissions: `packages: write`. Login with `GITHUB_TOKEN`.

**Verify**

```bash
docker build -t rclone-extractor .
docker run --rm -e APP_PASSWORD=test -p 8080:8080 rclone-extractor &
sleep 3
curl -s localhost:8080/healthz      # ok
docker images --format '{{.Repository}} {{.Size}}' | grep rclone-extractor  # <120MB
```

---

## 5. How to run the build sessions

1. Start a **new session** for each segment.
2. Paste this into the session:

```
Read /root/data/rx-webui-oc/RCLONE_EXTRACTOR_PLAN.md sections 0-3 only, then
build segment S<N> exactly as written. Only write the files S<N> owns. Run the
Verify commands and paste the real output. Follow the rules in section 0.
```

3. When the segment's verification passes, start the next segment in a new session.

Finished when S8's `docker run` returns `ok` from `/healthz` and the browser
dashboard updates while a job runs.

---

## 6. What changed vs the old plan (and why)

| Old | New | Reason |
|---|---|---|
| Rust + axum + tokio + askama | Bun + Hono + server-rendered strings | Async Rust lifetimes/borrow errors and compile loops were the main failure source; one language removes the whole class |
| tokio broadcast + SSE extension | htmx `every 1s` polling | No event contract, no reconnection, no client JS |
| rusqlite (bundled) | `bun:sqlite` | Built in, synchronous, zero build |
| `Mutex<HashSet>` session store | HMAC-signed cookie | No shared mutable state; restart-safe; far less code |
| askama templates | TypeScript string functions | No template engine, no separate syntax to learn |
| bundler + `app.ts` | plain htmx attributes | No build step at all |
| 7 large segments | ~12 small segments | Fits a 131K context and stays coherent |
| "watch the browser" verify | copy-paste curl / `bun test` | Machine-checkable, no ambiguity |
