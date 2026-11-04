# rclone-extractor

A small, self-hosted web app that scans an [rclone](https://rclone.org) remote
for archives, extracts them **in place**, promotes the results up a directory,
and moves the archive to a trash folder. It ships with a live dashboard, a
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
- **Live dashboard** — progress bar, ring, stage text, and done/failed/skipped
  counters update every second without a page reload.
- **Continue previous task** — resumable runs. If the app crashes or is
  restarted mid-job, archives stuck in *extracting* are automatically re-queued.
- **Choose your database** — SQLite by default, or a remote **PostgreSQL**
  server (e.g. Aiven, Supabase, RDS). Everything persists in the DB, so an
  ephemeral container filesystem loses nothing.
- **Encrypted secrets at rest** — the app password, `rclone.conf`, and the
  database URL are encrypted with AES-256-GCM when `SECRET_KEY` is set.
- **Portable backup** — export/import the whole dataset as JSON.
- **Dry-run mode** and password-protected single-user login.

---

## Quick start

### Docker (SQLite, zero config)

```bash
docker run -d --name rclone-extractor \
  -e APP_PASSWORD=change-me \
  -e SECRET_KEY=change-me-too \
  -p 8080:8080 \
  -v rclone-data:/data \
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
automatically on first boot.

### From source

```bash
bun install
bun run src/server.ts          # http://localhost:8080
bun test                       # run the test suite
```

---

## Configuration

All settings can be set on the **Configuration** page and are stored in the
database. They can also be seeded from environment variables.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | *(empty)* | Fallback login password, seeded into settings on first boot. |
| `SECRET_KEY` | *(empty)* | Passphrase for encrypting stored secrets. **Omit to disable encryption.** |
| `DATABASE_URL` | *(empty)* | Postgres connection string. When empty, SQLite at `DATA_DIR/app.db` is used. |
| `DATA_DIR` | `./data` | Directory for the SQLite file, logs, and the working `rclone.conf`. |
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
| `resume` | **Continue previous task.** Re-queue interrupted archives on boot/start. |
| `password` | Login password (encrypted at rest when `SECRET_KEY` is set). |
| `rclone_conf` | Uploaded rclone config (encrypted at rest). |

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
| Settings (incl. `rclone.conf`, password, DB URL) | `settings` table (secrets encrypted) |
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
> change `SECRET_KEY`, previously stored secrets can no longer be decrypted and
> login will fail. To recover, set `APP_PASSWORD` in the environment (it seeds
> the password) or clear the stored `password` setting, then sign in again.

If `SECRET_KEY` is unset, the app runs normally but stores secrets in plaintext
and shows a warning on the Configuration page.

---

## How it works

### Pipeline

For each archive at `<ROOT>/<REL>`:

```
list:    rclone lsf <ROOT> --recursive --files-only --format ps --separator ";"
extract: rclone archive extract <ROOT>/<REL> <ROOT>/<TMPREL> --stats 1s --stats-one-line
promote: rclone move <ROOT>/<TMPREL> <ROOT>/<PARENT> --delete-empty-src-dirs
cleanup: rclone purge <ROOT>/<TMPREL>
trash:   rclone moveto <ROOT>/<REL> <ROOT>/<trash_subdir>/<REL>
```

`<TMPREL>` is `.rclone-extractor-tmp/<runid>/<stem>`. `remote_flags` is
appended to every command; `--dry-run` is added when `dry_run` is on.

### Continue previous task (resume)

- On **boot**, if `resume` is on, archives left in `extracting` by a crash are
  reset to `queued`.
- On **Start**, failed archives are re-queued, and stale `extracting` rows are
  recovered again (when `resume` is on).

This makes an interrupted run safe to resume by simply restarting the app.

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
  archive.ts       name/path helpers + isSupported
  engine.ts        the extract loop, run state, resume
  ui.ts            HTML layout + escaping
  routes/
    pages.ts       GET /  /config  /logs  /errors
    auth.ts        login/logout + signed-cookie middleware
    dashboard.ts   GET /dashboard/fragment (htmx poll target)
    actions.ts     POST /run/start  /run/stop  /config  /rclone-conf
    logsapi.ts     GET /logs/fragment  /errors/fragment  + downloads
    data.ts        POST /export  POST /import
public/
  styles.css       design system
  htmx.min.js      vendored htmx
  fonts/           self-hosted JetBrains Mono
```

### HTTP routes

```
GET  /                     dashboard            (auth)
GET  /config               configuration        (auth)
GET  /logs  /errors        log & error pages    (auth)
GET  /login  POST /login  POST /logout
GET  /dashboard/fragment   live status          (auth)
GET  /dashboard/controls   run controls         (auth)
GET  /logs/fragment        live log tail        (auth)
GET  /errors/fragment      error rows           (auth)
POST /run/start  /run/stop                     (auth)
POST /config  /rclone-conf                     (auth)
GET  /download/run/:id  /download/archive/:id  (auth)
POST /export  /import                          (auth)
GET  /healthz              "ok" (no auth)
GET  /public/*             static files (no auth)
```

---

## Backup & restore

On the Configuration page:

- **Export JSON** downloads `settings`, `archives`, `runs`, `logs`, and
  `log_lines`. Secrets (`rclone.conf`, `password`, `database_url`) are included
  only if you tick *include secrets*; they are re-encrypted with the current key
  on import.
- **Import** reads a previously exported JSON and merges it into the active
  database.

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
