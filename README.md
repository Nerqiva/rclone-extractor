# rclone-extractor

A small, self-hosted web app that scans an [rclone](https://rclone.org) remote
for archives, extracts them **in place**, promotes the results up a directory,
and moves the archive to a trash folder. It ships with a live progress page, a
configuration page, and log/error views.

Written in TypeScript and run directly by [Bun](https://bun.sh) — no build step,
no bundler, no client framework. The UI is server-rendered HTML with
[htmx](https://htmx.org) polling.

```
scan  →  extract  →  promote  →  trash
```

---

## Features

- **Scan any rclone remote** (S3, SFTP, Google Drive, local path, …) for
  supported archives: `.zip .tar .tar.gz .tgz .taz .tar.bz2 .tb2 .tbz .tbz2
  .tz2 .tar.lz .tar.lz4 .tar.xz .txz .tar.zst .tzst .tar.br .tar.sz .tar.mz`
- **Extract → promote → trash** pipeline, one archive at a time, fully
  cancellable mid-run.
- **Content filters before extraction** — every archive is inspected with
  `rclone archive list --files-only`; torrent/website/tiny/empty or
  unreadable archives are skipped, never extracted. Archives in `trash_subdir`
  are not queued.
- **Live progress page** — KPI cards, a segmented progress bar, stage text,
  per-run rate/ETA, the active rclone command, done/failed/skipped counters,
  and a slim live bar with the current extraction's progress, speed and ETA
  update every second without a page reload.
- **Mobile-friendly logs** — the log and error views are selectable text with
  Copy all / Copy selection / Select all / Download controls.
- **Continue previous task** — resumable runs. If the app crashes or is
  restarted mid-job, archives stuck in *extracting* are automatically re-queued.
  Runs closed by crash recovery are shown as **Interrupted** (not *Completed*)
  on the progress and logs pages.
- **Choose your database** — SQLite by default, or a remote **PostgreSQL**
  server (e.g. Aiven, Supabase, RDS). Everything persists in the DB, so an
  ephemeral container filesystem loses nothing.
- **Encrypted secrets at rest** — `rclone.conf` and the database URL are
  encrypted with AES-256-GCM when `SECRET_KEY` is set. The login password is
  read from `APP_PASSWORD` at runtime and is never stored.
- **Portable backup** — export/import the whole dataset as JSON.
- **Dry-run mode** and `APP_PASSWORD`-protected single-user login.

---

## Quick start

### Docker (SQLite, zero config)

```bash
docker run -d --name rclone-extractor \
  -e APP_PASSWORD=change-me \
  -e SECRET_KEY=change-me-too \
  -p 8080:8080 \
  -v rclone-data:/app/data \
  ghcr.io/<owner>/rclone-extractor:latest
```

Open <http://localhost:8080> and sign in with `APP_PASSWORD`.

### Docker with PostgreSQL

```bash
docker run -d --name rclone-extractor \
  -e APP_PASSWORD=change-me \
  -e SECRET_KEY=change-me-too \
  -e DATABASE_URL='postgres://user:pass@host:5432/db?sslmode=require' \
  -p 8080:8080 \
  ghcr.io/<owner>/rclone-extractor:latest
```

When `DATABASE_URL` is set, Postgres is used and the schema is created
automatically on first boot. Existing databases are migrated automatically on
boot as well (currently: the `runs.interrupted` flag used to show crashed-but-
closed runs as **Interrupted**).

### Deploy on SnapDeploy (containers)

SnapDeploy deploys the Docker image from your GitHub repository; no manifest
file is needed.

1. Push this repository to GitHub.
2. In SnapDeploy open **Containers → Deploy → Deploy from GitHub** and select
   the repo and branch.
3. SnapDeploy scans the repo and shows the variables listed in
   **`.env.example`**. Fill in `APP_PASSWORD` and `SECRET_KEY`.
4. **`DATABASE_URL` is optional**: leave it empty for local SQLite, or attach a
   SnapDeploy **PostgreSQL add-on** (its connection string is injected as
   `DATABASE_URL`) / paste an **external** Postgres string (Neon, Supabase,
   RDS, Aiven). Data stored in SQLite lives on the container filesystem and is
   lost on redeploy; Postgres persists.
5. The image is multi-arch (`linux/amd64` and `linux/arm64`) and picks the
   matching `rclone` at build time, so the same image runs everywhere.
6. If something is wrong, check **Configuration → Runtime** for the rclone
   check — it reports whether the binary runs, and shows the underlying error
   (including the exact CPU-architecture message for a wrong rclone build).

SnapDeploy injects its own managed `PORT` (replacing the one in the image) and
scans `Dockerfile`, `.env.example` and framework config for the variable
list, so `DATABASE_URL` appears on the **Environment Variables** screen before
the first deploy.

### From source

```bash
bun install
bun run src/server.ts          # http://localhost:8080
bun test                       # run the test suite
```

### Deploying on Render (or any host with a read-only disk)

The local filesystem is only needed for **SQLite** and the transient
`rclone.conf`. With **Postgres**, the app needs no writable disk at all.

- The default `DATA_DIR` is **`/app/data`**, inside the app directory owned by
  the runtime user, so SQLite works out of the box with no extra setup.
- **Recommended for persistence:** set `DATABASE_URL` and store everything in
  Postgres — the container filesystem can then be read-only, and data survives
  redeploys.
- **If using SQLite on a host with a mounted disk**, note the mount may be
  **root-owned** (Render persistent disks are), which the non-root `bun` user
  cannot write and produces `EACCES`. Either:
  - switch to Postgres (recommended), or
  - point `DATA_DIR` at a writable path, accepting that data under it is
    **ephemeral** and lost on redeploy.

The app never crashes on an unwritable disk: with Postgres it boots normally;
with SQLite it prints a clear message telling you to set `DATA_DIR` to a
writable path or configure `DATABASE_URL`.

### All environment variables (copy-paste)

Every variable in one block, one per line — the same list as
**`.env.example`** (which container PaaS deployments read automatically).
Comment out or delete what you don't need, then paste into your `.env`,
SnapDeploy, Render "Environment", or Docker `--env-file`.

```bash
# --- required ---
APP_PASSWORD=change-me                 # login password (environment only; never stored)
SECRET_KEY=change-me-too               # passphrase for encrypting stored secrets (omit to disable encryption)

# --- database (leave DATABASE_URL empty to use local SQLite) ---
DATABASE_URL=                          # e.g. postgres://user:pass@host:5432/db?sslmode=require
DATA_DIR=/app/data                     # SQLite file + working rclone.conf (only used for SQLite)

# --- rclone ---
RCLONE_CONF=                           # generate with: base64 -w0 rclone.conf
RCLONE_BIN=rclone                      # full path to rclone (arch-matching build, for hosts without /usr/local/bin/rclone)

# --- http ---
BIND=0.0.0.0                           # bind address
PORT=8080                              # listen port
```

> The remaining settings (`scan_root`, `remote_flags`, `queue_max`, `sort_by`,
> `sort_dir`, `trash_subdir`, `dry_run`, `resume`) are configured on the
> **Configuration** page and stored in the database. See the tables below.

---

## Configuration

All settings can be set on the **Configuration** page and are stored in the
database. They can also be seeded from environment variables.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | *(empty)* | Login password. Required for login; never stored in the database. When empty, login is disabled. |
| `SECRET_KEY` | *(empty)* | Passphrase for encrypting stored secrets. **Omit to disable encryption.** |
| `RCLONE_CONF` | *(empty)* | Base64-encoded `rclone.conf`, used as a fallback when the stored `rclone_conf` setting is empty. Generate with `base64 -w0 rclone.conf`. |
| `RCLONE_BIN` | `rclone` | Path to the rclone binary. Set this to a full path if your host does not have rclone on `PATH`, or if you must install the build that matches your CPU (arm64 vs amd64). |
| `DATABASE_URL` | *(empty)* | Postgres connection string. When empty, SQLite at `DATA_DIR/app.db` is used. |
| `DATA_DIR` | `/app/data` | Directory for the SQLite file and the working `rclone.conf`. Only needed when using SQLite. |
| `BIND` | `0.0.0.0` | HTTP bind address. |
| `PORT` | `8080` | HTTP port. |

### Settings (Configuration page)

| Setting | Description |
|---|---|
| `scan_root` | rclone remote or path to scan, e.g. `s3:bucket/archives` or `/data/in`. |
| `remote_flags` | Extra flags appended to every rclone command, e.g. `--config /data/rclone.conf`. |
| `database_url` | Read-only view of the Postgres URL the app started with. Set the `DATABASE_URL` env var and restart to change it. |
| `queue_max` | Maximum archives queued per run (default `500`). |
| `sort_by` / `sort_dir` | Process order — `path` or `size`, `asc` or `desc`. |
| `dry_run` | When on, rclone runs with `--dry-run`; nothing is moved or deleted. |
| `trash_subdir` | Folder the processed archive is moved into (default `trash`). |
| `tmp_dir` | Where rclone extracts archives temporarily (default `.rclone-extractor-tmp`). A relative path resolves inside `scan_root`; use `remote:path/to/dir` or `/abs/local/path` to extract elsewhere. |
| `resume` | **Continue previous task.** Re-queue interrupted archives on boot/start. |
| `rclone_conf` | Base64-encoded rclone config (encrypted at rest). Falls back to the `RCLONE_CONF` environment variable when empty. |

Most settings are shown as compact rows on the Configuration page. Click **Edit**
to unfold a field, then **Save**. `remote_flags` stays permanently visible, and
`database_url` is read-only because it is controlled by the environment.

### Switching between SQLite and Postgres

The backend is chosen **once at startup** from the environment:

- `DATABASE_URL` set → **Postgres**
- `DATABASE_URL` empty → **SQLite** (`DATA_DIR/app.db`)

To switch, set (or clear) `DATABASE_URL` and **restart** the app. The
Configuration page shows the active backend as a badge; its `database_url`
field is a **read-only** view of the value the app started with and cannot
change the backend on its own.

---

## Persistence model

Everything that matters lives in the database, so a container with an ephemeral
filesystem keeps all state across restarts:

| Data | Storage |
|---|---|
| Settings (incl. `rclone.conf`, DB URL) | `settings` table (secrets encrypted) |
| Archive queue & status | `archives` table |
| Run history & counters | `runs` table |
| Log output (run + per-archive) | `log_lines` table |

Only a transient working copy of `rclone.conf` is written to `DATA_DIR` when
rclone needs to read it.

---

## Secrets & encryption

When `SECRET_KEY` is set, the app encrypts the sensitive settings before
writing them:

- **Cipher:** AES-256-GCM
- **Key derivation:** `scrypt(SECRET_KEY, per-value salt, 32 bytes)`
- **Format:** `enc:v1:<base64(salt | iv | authTag | ciphertext)>`

Values are encrypted on write and decrypted transparently on read. Existing
plaintext secrets are **encrypted automatically on first boot** after you set
`SECRET_KEY`.

> **Important:** the encryption key is only as safe as `SECRET_KEY`. If you
> change `SECRET_KEY`, previously stored secrets (`rclone.conf`, database URL)
> can no longer be decrypted; re-enter them on the Configuration page. Login is
> unaffected because `APP_PASSWORD` comes from the environment.

If `SECRET_KEY` is unset, the app runs normally but stores secrets in plaintext
and shows a warning on the Configuration page.

---

## How it works

### Pipeline

For each archive at `<ROOT>/<REL>`:

```
list:    rclone lsf <ROOT> --recursive --files-only --format ps --separator ";"
inspect: rclone archive list <ROOT>/<REL> --files-only
extract: rclone archive extract <ROOT>/<REL> <TMPDIR>/<runid>/<archiveid>/<stem> --stats 1s --stats-one-line --log-level INFO
promote: rclone move <TMPDIR>/<runid>/<archiveid>/<stem> <ROOT>/<PARENT> [--exclude /<tmp-top-segment>/**] --delete-empty-src-dirs
cleanup: rclone purge <TMPDIR>/<runid>/<archiveid>/<stem>
rmdir:   rclone rmdir <TMPDIR>/<runid>/<archiveid> (then <runid>/ and the tmp root; falls back to purge when not empty)
trash:   rclone moveto <ROOT>/<REL> <ROOT>/<trash_subdir>/<REL>
```

`<TMPDIR>` is the configured `tmp_dir` (default `.rclone-extractor-tmp`):
a relative path is resolved under `<ROOT>`, while `remote:path/to/dir` or
`/abs/local/path` are used as-is. `<TMPDIR>/<runid>/<archiveid>/<stem>` so two
archives with the same filename cannot collide.

`remote_flags` is appended to
every command; `--dry-run` is added when `dry_run` is on (`archive list` is
read-only and never gets `--dry-run`). The active command is written to both
the run log and, for per-archive work, the archive log; when a stage fails,
the command and its output are also written to the errors log.

`promote` passes `--exclude /<tmp-top-segment>/**` (only when `tmp_dir` is a
relative path nested inside the scan root) because `rclone move` refuses to
run when the source is nested inside the destination
(`OverlappingFilterCheck`). The pattern is anchored to the top level, so
archive contents that are themselves named like the temp dir are still
promoted, and an absolute `tmp_dir` needs no exclusion. Without the exclusion,
when tmp is nested, every promotion fails with
"can't sync or move files on overlapping remotes".

The `extract` step streams its output: rclone prints single-line transfer
stats once per second (`--stats-one-line`); the app parses those lines to drive
the live "Current extraction" meter on the progress page and filters them out
of the archive log, so a long extract does not spam the log with one line per
second. The command line and everything rclone reports besides stats lines are
still logged.

Directories matching the app's run layout (`<runid>/` with numeric names, as
created under `tmp_dir`) are purged automatically at boot, at the start of
every run, and at the end of a run; the last cleanup of a non-empty directory
falls back from `rclone rmdir` to `rclone purge`. Non-app entries inside
`tmp_dir` are never deleted — they are left alone and only logged. The
Configuration page also has a **Purge temp directory** maintenance action.
`dry_run` disables destructive cleanup entirely.

### Content filters (before extraction)

Every archive is inspected before anything is extracted, using
`rclone archive list --files-only`. Only files are counted — directories are
excluded — and all extension/name matching is case-insensitive. Sizes are in
bytes, and KB means 1024 bytes.

An archive is **skipped** (`status='skipped'`, never extracted) when ANY of
these holds:

| Skip reason | Rule |
|---|---|
| `empty` | The archive lists 0 files. |
| `torrent` | ≥ 60% of files are `.torrent`. |
| `website` | At least one file is a website marker (`.html .htm .xhtm .xhtml .css .js .woff .woff2 .eot`, `robots.txt`, `index.html`, `sitemap.xml`) **and** ≥ 20% of files are smaller than 100 KB. |
| `tiny` | ≥ 60% of files are smaller than 20 KB. |
| `unreadable` | `archive list` fails (corrupt, truncated, or otherwise unreadable/unsupported). |

If the listing error mentions a password, the skip reason is `password`
(same as a password failure during extraction). Skipped archives are never
re-queued on later runs and stay in place; the reason is visible on the
Errors page and in the per-archive log.

### Queue and re-runs

- `queue_max` (clamped to a positive integer) caps both how many paths are
  accepted while listing and how many queued rows are selected for a run.
- New paths are added as `queued`. Archives whose path lives under
  `trash_subdir` are ignored both while listing and when the run selects
  queued rows, so they are never (re-)processed.
- A path already marked `done` that appears in
  the listing again is treated as a new upload and re-queued — except in
  dry-run mode, where the original archive is never moved and re-queueing would
  repeat the same work every run.
- **Start** re-queues archives in the `failed` state and clears their
  `error_kind`. `resume` also recovers archives stuck in `extracting` after a
  crash.
- **Stop** is a soft stop: the button becomes **Force stop**, the panel shows a
  persistent "Stop requested" message, and the current archive finishes before
  the run stops (ending with the `cancelled` stage). A second click on
  **Force stop** kills the in-flight rclone process immediately; the interrupted
  archive is re-queued (never counted as done/failed/skipped) and the run ends
  as `cancelled`.
- All action buttons share the same feedback: a spinner and disabled state
  while the request is in flight, then a toast (via the `HX-Trigger` response
  header) reporting the outcome.
- An archive becomes `done` only when extract, promote, cleanup, and trash all
  succeed. Cleanup failure is logged as a warning; extract, promote, or trash
  failure marks the archive `failed`. A run stopped by the user ends with the
  `cancelled` stage, and unfinished runs are closed on the next boot and marked
  `interrupted`, so the UI shows them as **Interrupted** rather than *Completed*.

### Continue previous task (resume)

- On **boot**, if `resume` is on, archives left in `extracting` by a crash are
  reset to `queued`.
- On **Start**, failed archives are re-queued, and stale `extracting` rows are
  recovered again (when `resume` is on).

This makes an interrupted run safe to resume by simply restarting the app.

### Logs

The **Logs** page opens on the current (latest) session. While a task is
running, only that live session is shown. When the app is idle, the same log
window has a session picker so older runs can be viewed without leaving the
page, plus tabs for the run log and the errors log.

- Polling is **incremental** (`?after=<line-id>`): only new lines are fetched
  and appended, and polling stops as soon as the run finishes — finished
  sessions render statically, so they don't poll at all.
- The log view is **mobile-friendly and selectable**: every line is real text,
  you can tap and hold to select parts of it, or use the toolbar buttons
  **Copy all**, **Copy selection**, **Select all** and **Download**.
- **Copy all**/**Download** export the session and tab; **Copy selection**
  copies whatever you have selected; **Select all** selects the whole log for
  partial manual copying. Clipboard fallbacks work on plain-HTTP self-hosted
  deployments too.
- The **Errors** page has a **Copy all** button for a tab-separated summary
  and a per-row **Copy** button that fetches that archive's extract log
  (the failure and the command that produced it).

### Backend adapter

`src/db/` exposes one async `Store` interface with two implementations:

- `sqlite.ts` — `bun:sqlite`, synchronous under the hood.
- `postgres.ts` — `Bun.SQL` (built into Bun), no extra dependency.

A small SQL dialect layer rewrites the few divergent statements
(`AUTOINCREMENT` → `BIGSERIAL`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
`INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE`, `?` → `$n`).

---

## Architecture

```
src/
  server.ts        entry: init DB, boot resume, wire routes, listen
  config.ts        env + paths
  crypto.ts        AES-256-GCM secret encryption
  db/              Store interface + sqlite/postgres backends + schema
  log.ts           DB-backed logger + tail/read helpers
  rclone.ts        rclone command wrapper
  archive.ts       name/path helpers, archive content filters, isSupported
  engine.ts        the extract loop, run state, resume
  ui.ts            HTML layout + escaping
  routes/
    pages.ts       GET /  /config  /logs  /errors
    auth.ts        login/logout + signed-cookie middleware
    dashboard.ts   GET /dashboard/fragment (progress panel poll target)
    actions.ts     POST /run/start  /run/stop  /config  /rclone-conf
    logsapi.ts     GET /logs/fragment  /errors/fragment  + downloads
    data.ts        POST /export  POST /import
public/
  styles.css       design system
  htmx.min.js      vendored htmx
  copy.js          clipboard copy + incremental live-log polling
  fonts/           self-hosted JetBrains Mono
```

### HTTP routes

```
GET  /                     task progress        (auth)
GET  /config               configuration        (auth)
GET  /logs  /errors        log & error pages    (auth)
GET  /login  POST /login  POST /logout
GET  /dashboard/fragment   live progress panel  (auth)
GET  /dashboard/controls   run controls         (auth)
GET  /logs/fragment        incremental log tail  (auth)
GET  /errors/fragment      error rows           (auth)
POST /run/start  /run/stop                     (auth)
POST /config  /rclone-conf  /config/rclone-clear  (auth)
POST /maintenance/archives  /maintenance/runs  /maintenance/all  /maintenance/tmp-purge  (auth)
GET  /download/run/:id  /download/archive/:id  (auth)
POST /export  /import                          (auth)
GET  /healthz              "ok" (no auth)
GET  /public/*             static files (no auth)
```

---

## Backup & restore

On the Configuration page:

- **Export JSON** downloads `settings`, `archives`, `runs`, `logs`, and
  `log_lines`. Secrets (`rclone.conf`, `database_url`) are included only if you
  tick *include secrets*; they are re-encrypted with the current key on import.
  A legacy `password` setting in an old export is ignored on import.
- **Import** reads a previously exported JSON and merges it into the active
  database.
- Both actions run in place: a spinner shows progress and a toast reports the
  result without navigating away from the Configuration page.

The export is backend-independent, so it can move data between SQLite and
Postgres.

---

## Development

```bash
bun install          # install Hono + Bun types
bun run src/server.ts
bun test
```

The test suite includes a **documentation drift guard** (`tests/readme.test.ts`):
it fails if any registered route, environment variable, or user-facing setting
is missing from this README, and also if the documented route list mentions an
endpoint that no longer exists. CI runs it on every push, so keep this file in
sync when adding or removing endpoints, env vars, or settings.

Run against a local Postgres:

```bash
DATABASE_URL='postgres://user:pass@localhost:5432/rclone' \
SECRET_KEY=dev-key APP_PASSWORD=dev bun run src/server.ts
```

---

## Tech stack

| Need | Choice |
|---|---|
| Runtime | Bun 1.4.x |
| HTTP | Hono 4.x |
| Database | `bun:sqlite` or `Bun.SQL` (Postgres) |
| Processes | `Bun.spawn` (rclone) |
| Encryption | Node `crypto` (AES-256-GCM) |
| UI | htmx 2.0.11, server-rendered |

No bundler, no client framework, no ORM.
