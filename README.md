# rclone-extractor

A small, self-hosted web app that scans an [rclone](https://rclone.org) remote
for archives, extracts them **in place**, promotes the results up a directory,
and moves the archive to a trash folder. It ships with a live progress page, a
configuration page, and log/error views.

Written in TypeScript and run directly by [Bun](https://bun.sh) — no build step,
no bundler, no client framework. The UI is server-rendered HTML with
[htmx](https://htmx.org) polling. Polled fragments are merged into the page by
[morphdom](https://github.com/patrick-steele-idem/morphdom), so only values that
changed are replaced and text you select stays selected.

```
scan  →  extract  →  promote  →  trash
```

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/progress.png" alt="Progress page showing a completed run: the progress bar at 100%, counters for done, failed and skipped archives, scan root and controls" width="100%"><br>
      <sub><strong>Progress</strong> — live task tracking with counters and queue</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/configuration.png" alt="Configuration page with connection and selection sections, backend info and app password status" width="100%"><br>
      <sub><strong>Configuration</strong> — connection, selection and security settings</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/logs.png" alt="Logs page with a session picker, a Finished pill and a colorized raw run log" width="100%"><br>
      <sub><strong>Logs</strong> — colorized raw output with session picker</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/errors.png" alt="Errors page with an Informational skips section above a password-protected section, each card showing its queue ID and raw log actions" width="100%"><br>
      <sub><strong>Errors</strong> — failures, informational skips and password-protected files</sub>
    </td>
  </tr>
</table>

---

## Features

- **Scan any rclone remote** (S3, SFTP, Google Drive, local path, …) for
  supported archives: `.zip .tar .tar.gz .tgz .taz .tar.bz2 .tb2 .tbz .tbz2
  .tz2 .tar.lz .tar.lz4 .tar.xz .txz .tar.zst .tzst .tar.br .tar.sz .tar.mz`,
  plus (when RcloneX is enabled) `.rar .7z .iso` and multivolume archives
  (`.partN.rar`, `.7z.NNN`).
- **Extract → promote → trash** pipeline, one archive at a time, fully
  cancellable mid-run.
- **RcloneX integration** (optional) — when enabled, **all** archives are
  extracted with [Nerqiva/rclonex](https://github.com/Nerqiva/rclonex),
  including ZIP and TAR. RAR/RAR5, multivolume RAR, 7Z, multivolume 7Z and
  ISO9660 are queueable only while the setting is on; rclone still handles
  listing, inspection, promotion, cleanup and trash. Encrypted archives and
  entry-error tolerance are exposed as Configuration-page checkboxes.
- **Same-series archives in one directory skip pre-inspection** — the first
  archive of one archive family per directory (per run) is inspected before
  extraction; the rest of a similar incremental/decremental series are
  extracted first and inspected on the extracted tree instead (website dumps
  and torrent collections are skipped there, mirroring the RcloneX path).
  If the first archive fails inspection, the whole group keeps
  pre-inspection. Dissimilar names, a different archive family, or a
  subdirectory each start their own group; nothing persists across runs.
- **Content filters before extraction** — every archive is inspected with
  `rclone archive list --files-only`; torrent/website/tiny/empty or
  unreadable archives are skipped, never extracted. Archives in `trash_subdir`
  are not queued. Archives classified as website dumps (two or more distinct
  web-development extensions anywhere in the archive) are skipped entirely.
  For RcloneX-handled formats (RAR/7Z/ISO/multivolume) — where inspection
  streams the whole archive — inspection additionally runs **after
  extraction** on the extracted tree: website dumps and torrent collections
  are skipped then (the extracted data is deleted, the archive is kept in
  place). Everything else continues as a normal extraction. The same
  extract-first path also applies to the same-series rest of a group (see
  "Content filters" below).
- **Configuration is editable mid-run** — the Configuration page stays
  usable while a task runs; changes apply from the next run (the running
  task uses a private snapshot of `rclone_conf`), and the Progress page
  shows the running task's scan root.
- **Live progress page** — KPI cards, a segmented progress bar, stage text,
  per-run rate/ETA, the active rclone command, done/failed/skipped counters,
  and a slim live bar that follows the in-flight rclone command: real progress
  (bytes/speed/ETA) for transfer commands (extract / move / moveto), an
  indeterminate sweeping bar for the rest (lsf, archive list, purge).
  Updates every second without a page reload.
- **Skip controls** — skip the listing stage, the current archive's
  inspection, or the current archive entirely. Skips are temporary, this run
  only, and never persist; a skipped archive stays queued for the next run.
- **Automatic scan reuse** — the cached archive list from the last completed
  scan is reused when the configuration is unchanged, instead of rescanning
  the remote. Any configuration change or incomplete cache falls back to a
  fresh scan.
- **Mobile-friendly logs** — the log and error views are selectable text with
  Copy all / Copy selection / Select all / Download controls.
- **Task-first interface** — system UI typography for navigation and controls,
  monospaced data for logs and values, sentence-case labels, and direct links
  from the empty Progress page to configuration, logs and errors.
- **Continue previous task** — resumable runs. If the app crashes or is
  restarted mid-job, archives stuck in *extracting* are automatically re-queued.
  Runs have an explicit outcome: a **user stop** ends as **Interrupted**, a
  **host/process stop** (deploy `SIGTERM`, SIGKILL, OOM, crash) ends as
  **Killed**, and an **app-caused error** ends as **Error** with an error code
  (see the Logs page, Errors tab, and the run log). The finished/ended time is
  shown on the progress page when a run is not running, and the cause and time
  appear alongside the badge.
- **Choose your database** — SQLite by default, or a remote **PostgreSQL**
  server (e.g. Aiven, Supabase, RDS). Everything persists in the DB, so an
  ephemeral container filesystem loses nothing.
- **Encrypted secrets at rest** — `rclone.conf` and the database URL are
  encrypted with AES-256-GCM when `SECRET_KEY` is set. The login password is
  read from `APP_PASSWORD` at runtime and is never stored.
- **Portable backup** — export/import the whole dataset as JSON.
- `APP_PASSWORD`-protected single-user login.

---

## Quick start

### Docker (SQLite, zero config)

```bash
docker run -d --name rclone-extractor \
  -e APP_PASSWORD=change-me \
  -e SECRET_KEY=change-me-too \
  -p 8080:8080 \
  -v rclone-data:/app/data \
  -v /path/to/rclone.conf:/app/data/rclone.conf:ro \
  ghcr.io/<owner>/rclone-extractor:latest
```

Every rclone invocation gets `--config /app/data/rclone.conf` baked in. Mount
your `rclone.conf` there (or store one in the app / `RCLONE_CONF` env, which
is written to that path before each run; if the path is not writable for any
reason the working copy is kept at `/tmp/app/data/rclone.conf` instead, with a
warning and a toast). The per-command extra-flag settings never need a
`--config`; one placed there is ignored.

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
boot as well (currently: the `runs.interrupted` flag, and the newer
`outcome`/`error_kind` columns — runs closed by crash recovery before them
read as **Killed** — the `runs.last_archive` / `runs.last_command` columns
that keep the in-flight archive and command after an interruption, the
dropped legacy `logs` table, and the dropped `log_lines.seq` /
`sessions.created_at` columns). Index DDL failures
during schema install are logged and skipped rather than crashing the
process; a critical table that is missing or unreadable fails with a clear
error naming it.

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
- **If `/app/data` (or `DATA_DIR`) is not writable for any reason**, the
  stored `rclone.conf` working copy is kept at **`/tmp/app/data/rclone.conf`**
  instead; the app logs a warning and shows a toast. Everything else (SQLite)
  still needs a writable `DATA_DIR`.
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
DATA_DIR=/app/data                     # SQLite file (only needed for SQLite); rclone.conf working copy lives here too (falls back to /tmp/app/data if not writable)

# --- rclone ---
RCLONE_CONF=                           # generate with: base64 -w0 rclone.conf
RCLONE_BIN=rclone                      # full path to rclone (arch-matching build, for hosts without /usr/local/bin/rclone)
RCLONEX_BIN=rclonex                    # full path to the rclonex binary (Docker refreshes both binaries at startup into /app/data/bin; set this to pin your own)

# --- http ---
BIND=0.0.0.0                           # bind address
PORT=8080                              # listen port
APP_TZ=Asia/Omsk                       # timezone used for every time shown in the UI (DB and backups stay UTC)
```

> The remaining settings (`scan_root`, the per-command `*_extra_flags` fields,
> `queue_max`, `concurrency`, `max_archive_size`, `min_archive_size`, `sort_by`,
> `sort_dir`, `trash_subdir`, `resume`) are configured on the
> **Configuration** page and stored in the database. See the tables below.

---

## Configuration

All settings can be set on the **Configuration** page and are stored in the
database. They can also be seeded from environment variables.

**The Configuration page stays editable while a task is running.** Changes
are stored immediately but apply from the **next run** — the running task
is not affected. Specifically:

- Everything the run uses is read once at its start and kept for its whole
  lifetime (`scan_root`, limits, sort order, `concurrency`, `trash_subdir`, `tmp_dir`,
  `resume`, `auto_skip_known`, all RcloneX settings, and every
  `*_extra_flags` field).
- At its start the run also takes a **private snapshot of `rclone_conf`**
  (a mode-`0600` copy kept for the duration of the run and deleted when it
  ends), so an rclone.conf saved mid-run cannot leak into the in-flight
  task — every command it spawns is pinned to the snapshot.
- The saved configuration is what **on-demand** rclone calls use (e.g.
  downloading an archive from the Errors page) and what the **next** run
  uses — the shared working copy is updated as soon as you save.
- The Progress page shows the **running task's** scan root, not the stored
  setting.
- Still blocked while a task runs: **Import** (it replaces the database) and
  the destructive maintenance actions (**Clear logs**, **Clear tmp
  directory**, **Clear everything**). Password-protected **Delete/Restore**
  are accepted: they are queued and executed when the current archive
  finishes, with all checks repeated then. **Clear queues** stays available.

### Concurrent archives

The scan and queue building are always serial and finish before extraction
starts. The `concurrency` setting (1–8, default `1`) then decides how many
extraction workers run at once. Each worker takes one archive, runs the whole
inspect → extract → promote → trash pipeline, then takes the next. With the
default of `1` the behavior is unchanged; raising it processes different
archives in parallel.

Archives in the same directory and archive family are serialized: the first
one in queue order is pre-inspected, and only related later archives of that
group use the post-extraction inspection path. This keeps the inspection
verdict deterministic while unrelated groups run in parallel.

The Progress page shows one card per in-flight archive under **Archives in
flight** with its own phase, transfer bar, byte counts and ETA, plus a summary
strip with queued, active, done, failed, skipped and configured concurrency.
The **History** section keeps cards for the five most recently finished,
failed or skipped archives so old results do not crowd the page. Every card
shows its **Queue ID** — the archive's database id, also used on the Logs and
Errors pages and for downloads.

The queue is hidden by default. **Show Queue (N)** next to Start/Stop opens it
and lists up to 20 archives per page with Prev/Next controls. The **Skip
archive** button on an in-flight card targets only that archive. **Stop** lets
in-flight archives finish; **Force stop** kills all active processes and
re-queues every in-flight archive.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | *(empty)* | Login password. Required for login; never stored in the database. When empty, login is disabled and all pages and actions are open without a session, so only use this on a trusted network. |
| `SECRET_KEY` | *(empty)* | Passphrase for encrypting stored secrets. **Omit to disable encryption.** |
| `RCLONE_CONF` | *(empty)* | Base64-encoded `rclone.conf`, used as a fallback when the stored `rclone_conf` setting is empty. Generate with `base64 -w0 rclone.conf`. |
| `RCLONE_BIN` | `rclone` | Path to the rclone binary. Set this to a full path if your host does not have rclone on `PATH`, or if you must install the build that matches your CPU (arm64 vs amd64). |
| `RCLONEX_BIN` | `rclonex` | Path to the rclonex binary. The Docker image refreshes rclone and rclonex to the latest release at every container start (checksum-verified) into `/app/data/bin`; operator-provided `RCLONE_BIN` / `RCLONEX_BIN` override that. |
| `DATABASE_URL` | *(empty)* | Postgres connection string. When empty, SQLite at `DATA_DIR/app.db` is used. |
| `PG_POOL_MAX` | `4` | Max connections this app opens to Postgres (keep small; see below). |
| `COOKIE_SECURE` | `1` | Session cookie is `Secure` (HTTPS only). Set `0` only when serving over plain HTTP. |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-For`/`X-Real-IP` for the login throttle. Set `1` only behind a reverse proxy that sets them. |
| `DATA_DIR` | `/app/data` | Directory for the SQLite file and the transient `rclone.conf` working copy (falls back to `/tmp/app/data` if not writable for any reason). Only needed when using SQLite or a stored `rclone_conf`. |
| `BIND` | `0.0.0.0` | HTTP bind address. |
| `PORT` | `8080` | HTTP port. |
| `APP_TZ` | `Asia/Omsk` | IANA timezone used for every time shown in the UI (e.g. `Europe/Berlin`). The database and backups stay in UTC. Invalid values warn at boot and fall back to `Asia/Omsk`. |

### Settings (Configuration page)

| Setting | Description |
|---|---|
| `scan_root` | rclone remote or path to scan, e.g. `s3:bucket/archives` or `/data/in`. |
| `lsf_extra_flags` | Extra flags for `rclone lsf` (scan listing and temp-dir listing). |
| `archive_list_extra_flags` | Extra flags for `rclone archive list` (pre-extraction inspection). |
| `extract_extra_flags` | Extra flags for `rclone archive extract`. |
| `rclonex_extract_extra_flags` | Extra flags for `rclonex archive extract`. Password and window flags are configured separately. |
| `move_extra_flags` | Extra flags for `rclone move` (promotion). |
| `moveto_extra_flags` | Extra flags for `rclone moveto` (trash and Delete/Restore). |
| `cat_extra_flags` | Extra flags for `rclone cat` (downloads). |
| `lsl_extra_flags` | Extra flags for `rclone lsl` (exists check). |
| `lsjson_extra_flags` | Extra flags for `rclone lsjson` (size/mtime probe). |
| `purge_extra_flags` | Extra flags for `rclone purge` (temp cleanup). |
| `queue_max` | Maximum archives queued per run (default `500`). |
| `concurrency` | Number of archives processed at the same time, `1`–`8` (default `1`). The scan and queue are still built serially; raising this runs that many extraction workers in parallel. Takes effect from the next run. |
| `retry_cooldown_seconds` | Base wait before retrying a failed extract, promote (move) or trash (moveto), in whole seconds `0`–`86400` (default `60`). Each retry doubles it: 60s, 120s, 240s, for four attempts total. A skip request or hard stop ends the wait immediately and re-queues the archive; a soft stop waits it out. Password, website/torrent and other skip decisions are never retried. |
| `min_archive_size` | Ignore archives smaller than this: they are never queued and are re-evaluated on every run. Entered in MB or GB (stored in bytes); `0` = no limit (default). |
| `max_archive_size` | Ignore archives larger than this: they are never queued and are re-evaluated on every run, so raising the limit takes effect immediately. Entered in MB or GB (stored in bytes); `0` = no limit (default). |
| `rclonex` | **Enable RcloneX** (default off). When on, archives whose format rclone cannot handle — RAR/RAR5, multivolume RAR (`x.partN.rar` / `x.r00…`), 7Z, split/multivolume 7Z (`x.7z.NNN`), and ISO9660 — are queued (only the first volume of a set: `part1.rar` / `.7z.001` / plain `.rar`), and **every** queued archive, ZIP/TAR included, is extracted with rclonex. Listing, inspection, promotion, cleanup and trash stay on rclone. When off, those formats are not queued at all and rclone does all extraction. |
| `auto_skip_known` | Keep reappearing archives classified as a torrent or website dump skipped automatically (default on — they are never re-queued/re-inspected). Uncheck to re-inspect such reappearing archives on later runs. |
| `rclonex_archive_password_enabled` + `rclonex_archive_password` | RcloneX flag `--archive-password` (default off): password for encrypted RAR/7Z archives (multivolume sets included). The password is stored encrypted at rest; leaving the field blank on save keeps the stored value, and the **Clear** button removes it (disables the flag). |
| `rclonex_archive_buffer_size` | RcloneX flag `--archive-window-size` (how much of the archive is buffered in memory while rclonex reads random-access formats such as 7Z/ISO). Bytes; `0` keeps rclonex's own default. The Configuration page asks for MB/GB. |
| `sort_by` / `sort_dir` | Process order — `path` or `size`, `asc` or `desc`. |
| `trash_subdir` | Folder the processed archive is moved into (default `.Trash`). |
| `tmp_dir` | Where rclone extracts archives temporarily (default `.Rclone-Extractor-tmp`). A relative path resolves inside `scan_root`; use `remote:path/to/dir` or `/abs/local/path` to extract elsewhere. |
| `resume` | **Continue previous task.** Re-queue interrupted archives on boot/start; when off, they are marked `failed`/`killed`. |
| `rclone_conf` | Base64-encoded rclone config (encrypted at rest). Falls back to the `RCLONE_CONF` environment variable when empty. When set, it is written to `/app/data/rclone.conf` before rclone runs — if that path is not writable for any reason, it is written to `/tmp/app/data/rclone.conf` instead (warning in the server log and a toast). Otherwise the file at `/app/data/rclone.conf` (e.g. a mounted rclone.conf) is used as-is. |

Most settings are shown as compact rows on the Configuration page, each with a
single terse line of help. Click **Edit** to unfold a field, then **Save**.
The extra-flags rows stay permanently visible. The **Runtime** card on that page
shows the app version and the time the process booted, alongside the rclone
checks.

### Switching between SQLite and Postgres

The backend is chosen **once at startup** from the environment:

- `DATABASE_URL` set → **Postgres**
- `DATABASE_URL` empty → **SQLite** (`DATA_DIR/app.db`)

To switch, set (or clear) `DATABASE_URL` and **restart** the app. The
Configuration page shows the active backend (`Backend: sqlite` or
`Backend: postgres`); the backend is controlled exclusively by the environment.

#### Postgres connection troubleshooting

If the deploy log shows `PostgresError: remaining connection slots are
reserved for roles with the SUPERUSER attribute` (errno `53300`), the remote
Postgres service has hit its connection cap — the remaining slots are reserved
for superusers, so regular connections are refused. Note that this app does
not limit what else uses the same service: other apps or stale idle
connections can consume the slots too. Fix it on both sides:

1. **In the remote Postgres service:** raise `max_connections` (if your plan
   allows), terminate stale backends (`SELECT pg_terminate_backend(pid) FROM
   pg_stat_activity WHERE state = 'idle' ...` as a superuser), or point
   `DATABASE_URL` at the service's **connection pooler** (most hosted
   Postgres providers offer one — e.g. Neon/Supabase/Aiven/Render poolers or
   PgBouncer in transaction mode).
2. **In this app:** keep `PG_POOL_MAX` small (default `4`). The pool recycles
   idle connections after 20 s and the app closes its connections on
   `SIGTERM`, so deploys do not leak slots. Boot retries the database
   connection a few times before giving up instead of crash-looping.

Use `?sslmode=require` in the URL at minimum; use `verify-full` (with the
provider's CA) for internet-exposed databases.

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

Only a transient working copy of `rclone.conf` is written to
`/app/data/rclone.conf` when rclone needs to read it (or to
`/tmp/app/data/rclone.conf` when `/app/data` is not writable for any reason).

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
list:    rclone lsf <ROOT> --recursive --files-only --format ps --separator ";" --ignore-case --include "<each supported archive extension glob>" [--min-size <bytes>B] [--max-size <bytes>B]
inspect: rclone archive list <ROOT>/<REL> --files-only (skipped for RcloneX formats by default, always for ISO)
extract: rclonex archive extract <ROOT>/<REL> <TMPDIR>/run_<runid>/<archiveid>/<stem> --stats 1s --stats-one-line --log-level INFO
         (with the configured --archive-* flags; rclone's native `archive extract` is used only when RcloneX is disabled)
promote: rclone move <TMPDIR>/run_<runid>/<archiveid>/<stem> <ROOT>/<PARENT> [--exclude /<tmp-top-segment>/**] --delete-empty-src-dirs
cleanup: rclone purge <TMPDIR>/run_<runid>/<archiveid>/<stem>
purge:   rclone purge <TMPDIR>/run_<runid>/<archiveid> (and the run dir)
trash:   rclone moveto <ROOT>/<REL> <ROOT>/<trash_subdir>/<REL>
```

`extract`, `promote` and `trash` are each retried after a failure: four attempts
in total, with waits of `retry_cooldown_seconds`, twice that and four times
that (60s, 120s, 240s by default). Listing, inspection, cleanup/purge and
skipped archives are never retried. Every attempt gets its own `$ <redacted
command>` marker and raw output block in the archive log, and the run log gets
one `retry N/3 after Xs: <command> <archive>` line before each wait. A
re-extract first purges the stem temp dir so partial output cannot leak. A skip
request or hard stop during a cooldown aborts the wait and re-queues the
archive; a soft stop waits it out. Password, website/torrent, empty and
unreadable archives are never resurrected by a retry.

The listing is spawned with `--ignore-case` and one `--include` glob per
supported archive extension (RAR/7z/ISO and split `name.7z.NNN` volumes only
when RcloneX is enabled), plus `--min-size`/`--max-size` (bytes, inclusive
bounds) mirroring `min_archive_size`/`max_archive_size`. rclone applies the
filters as objects stream in, so far fewer non-archive lines are streamed,
parsed and checked; the remote still enumerates everything. The app
re-checks names and sizes itself as a backstop, so behavior is unchanged on
odd backends that report sizes differently. Old-style `.rNN` volumes are
never emitted by the glob list and never queued. Multivolume first-volume
selection (`.part1.rar`, `.7z.001`) still happens in-app — the globs match
volumes 2..N too, because globs cannot express "zero or more padding then
1". An archive sized exactly at a limit is kept.

`<TMPDIR>` is the configured `tmp_dir` (default `.Rclone-Extractor-tmp`):
a relative path is resolved under `<ROOT>`, while `remote:path/to/dir` or
`/abs/local/path` are used as-is. `<TMPDIR>/run_<runid>/<archiveid>/<stem>` so
two archives with the same filename cannot collide and the sweeper can tell
the app's directories apart from anything else. The maintenance/boot sweep
removes stale `run_<digits>` directories inside `<TMPDIR>` — anything else is
left alone, including directories owned by a live instance on shared
Postgres.

Each `*_extra_flags` field is appended only to its own subcommand. Nothing
leaks into another command, and `--config` is always ignored. All rclone output streams are stored
verbatim: the run log carries human-readable annotations plus every command
the app runs, while each per-archive archive log holds the binary's raw output
grouped by command. A `---` separator and a `$ <redacted command>` line mark
the start of each command's output, so a log with several commands is easy to
read and the failing one is identifiable. Failures that produce no binary
output at all store a single diagnostic line so downloads are never empty 404s
(see the Errors page note below). The **Errors** page and per-archive downloads
show that output.

`promote` passes `--exclude /<tmp-top-segment>/**` (only when `tmp_dir` is a
relative path nested inside the scan root) because `rclone move` refuses to
run when the source is nested inside the destination
(`OverlappingFilterCheck`). The pattern is anchored to the top level, so
archive contents that are themselves named like the temp dir are still
promoted, and an absolute `tmp_dir` needs no exclusion. Without the exclusion,
when tmp is nested, every promotion fails with
"can't sync or move files on overlapping remotes".

Every rclone command shows its own live status and a thin progress bar in the
same slot on the progress page: the listing (`lsf`), the queue build, the
archive inspection (`archive list`), the extraction, the promotion (`move`),
and the trash move (`moveto`) update one stage at a time as they cycle.
Transfer commands stream single-line stats once per second (`--stats-one-line`);
the app parses those lines to drive a live byte/percent/speed/ETA bar and
filters them out of the archive log (they carry no error signal); everything
else rclone writes is logged. Commands without byte progress (lsf, archive
list, purge) show an indeterminate bar instead. Retry waits are announced in
the run log with the attempt number and cooldown seconds.

Directories matching the app's run layout (`run_<digits>/`, as created
under `tmp_dir`) are purged automatically at boot, at the start of every run,
and at the end of a run; non-empty directories are removed with `rclone
purge`. Anything else inside `tmp_dir` is never deleted — it is left alone
and only logged. The Configuration page also has a **Clear tmp directory**
maintenance action.

The Configuration page's maintenance actions (each asks for confirmation;
all are disabled while a task is running except **Clear queues**):

- **Clear queues** deletes queued archives (and their archive log rows) —
  even while a task is running; the running engine skips the deleted rows.
  Run count, history and the archive cache are kept.
- **Clear logs** wipes logs and errors only — log lines and the `/errors`
  failure index (`error_kind`). Runs and archives are kept.
- **Clear tmp directory** purges stale app-owned `run_<digits>` dirs.
- **Clear everything** wipes queue, history, logs, errors and the tmp
  directory; next run starts from #1.

### RcloneX (optional)

[Nerqiva/rclonex](https://github.com/Nerqiva/rclonex) is a public fork of
rclone that extends `archive extract` with streaming remote-to-remote
extraction for **RAR/RAR5, multivolume RAR, 7Z, multivolume 7Z and ISO9660**.
Enable it with **Enable RcloneX** on the Configuration page. While enabled,
rclonex performs **all** extraction, including ZIP and TAR.

- **Enable RcloneX is the format gate** — the RcloneX-only formats above are
  queued only while the setting is on; once on, every queued archive is
  extracted with rclonex. Promotion/move/trash/purge stay rclone operations
  in both modes.
- **Multivolume sets** — only the first volume is queued and extracted:
  `name.part1.rar` (or `part01.rar`), `name.rar` (old-style `.r00…` sets), and
  `name.7z.001`. Volumes 2..N are never queued. The stem used for temp
  extraction names strips the multivolume marker.
- **RAR5** is supported as part of the RAR format — no separate toggle.
- When RcloneX is disabled, those formats are not queueable at all (they are
  filtered out of the listing exactly like `.sqfs`), and every archive-family
  capability beyond upstream rclone is off.
- **Inspection happens after extraction** for RcloneX-handled archives
  (RAR/RAR5, 7Z, ISO9660): the archive is extracted into a temporary tree
  and **then** the extracted contents are listed. This avoids a slow
  full-stream `archive list` read, and works for ISO9660, which cannot be
  identified by `archive list` anyway. A **Skip inspection** control still
  appears while the (rclone) inspection of a ZIP/TAR archive is in flight,
  treating it as passed for that archive only.
- **Content checks are applied to the extracted tree.** After extraction,
  the tree is classified exactly like a pre-extraction listing: a dump with
  two or more distinct web-development extensions is treated as a
  **website dump**, and a collection that is at least 60% `.torrent` files
  as **torrent**; in both cases the extracted tree is purged from the
  temporary directory and the archive is left in place (never promoted,
  never moved to trash). ZIP/TAR/etc. are classified before extraction as
  before — except the "rest of the series" archives of a directory that
  contains multiple same-family archives (see **Content filters**), which
  are classified on the extracted tree like the RcloneX formats.
- **Flags**: `--archive-password` (encrypted at rest, blank field on save
  keeps the stored value, **Clear** removes it) and `--archive-window-size`
  (bytes; `0` disables caching) are exposed as Configuration checkboxes, all
  **off by default**. Use `rclonex_extract_extra_flags` for other `--archive-*`
  flags; they reach rclonex only and never the rclone binary, where they would
  make every command fail.
- **Docker**: at every container start the entrypoint refreshes both
  **rclone** and **rclonex** to the latest release into `/app/data/bin`
  (checksum-verified: rclone against the signed `SHA256SUMS` on
  downloads.rclone.org, rclonex against the release's `checksums.txt`, and
  rclonex prefers the latest stable release, falling back to the newest
  pre-release). Restarts are cheap — the refresh only runs when a newer
  release exists. If the download or verification fails (e.g. no network at
  boot), the previous binary is kept and the app starts either way; the
  image also bakes in build-time copies at `/usr/local/bin` as an offline
  floor. `RCLONE_BIN` / `RCLONEX_BIN` set by the operator always win. The
  config page shows an rclonex version row when the feature is enabled.

### Content filters

For rclone-handled formats (ZIP, TAR, …), every archive is inspected before
anything is extracted, using `rclone archive list --files-only`. Only files
are counted — directories are excluded — and all extension matching is
case-insensitive. Sizes are in bytes, and KB means 1024 bytes.

For RcloneX-handled formats (RAR/RAR5, 7Z, ISO9660), the archive is
extracted to a temporary tree first, and the extracted contents are
classified in the same way.

**Multiple archives of one family in one directory.** Listing the extracted
tree is usually faster than `archive list`, so the run applies a
directory-level rule on top of the above. Archives are grouped by their
**parent directory** (no recursion) and by archive **family** — aliases of
one format share a family (`.tgz` is `.tar.gz`, `.tbz2` is `.tar.bz2`, and so
on), and RcloneX-handled formats are excluded from the rule entirely. Within
one group, the first archive in queue order keeps pre-extraction inspection.
The remaining archives whose names are **related** to the first archive's
name — same digit-free skeleton after stripping digits and non-letters
(`pack1.zip`, `pack02.zip`; `movie.2020.zip`, `movie.2021.zip`;
`archive (1).zip`, `archive (2).zip`), or Levenshtein similarity ≥ 0.8 —
are extracted into the temporary tree first and inspected there, exactly
like RcloneX-handled formats: website dumps and torrent collections are
purged from the temporary directory and the archive stays in place (never
promoted, never moved to trash). A group whose first archive **failed**
inspection (torrent, website, tiny, empty, unreadable/password) keeps
pre-extraction inspection for all of its archives. Unrelated filenames and
archives of a different family in the same directory are pre-inspected
individually. An empty extracted tree is promoted as usual. The grouping is
per run and per
archive type — it is kept in memory only, and the next run starts from
scratch.

An archive is **skipped** (`status='skipped'`, never extracted) when ANY of
these holds:

| Skip reason | Rule |
|---|---|
| `empty` | The archive lists 0 files. |
| `torrent` | ≥ 60% of files are `.torrent`. |
| `website` | Two or more **distinct** recognized web-development file extensions (`.html .htm .xhtml .xhtm .css .scss .less .js .mjs .cjs .map .php .asp .aspx .jsp .vue .svelte .astro .woff .woff2 .eot`) are found anywhere in the archive — root or any nested directory. File sizes are not considered. |
| `tiny` | ≥ 60% of files are smaller than 20 KB. |
| `unreadable` | `archive list` fails (corrupt, truncated, or otherwise unreadable/unsupported). |

If the failure output mentions a password, the skip reason is `password`
(same as a password failure during extraction). Skipped password archives are
never re-queued on later runs; they are listed on the Errors page's
**Password-protected** section, where they can be downloaded, moved to trash,
or restored to the queue. Archives previously skipped as a
torrent or website dump that reappear in a later listing are auto-skipped by
default (see `auto_skip_known`).

Error rows store the underlying diagnostics. Failures caused by the **rclone
binary** write its raw output to the per-archive log; failures caused by the
**web app** (e.g. `unsafe_path`, `killed`, and the skip classifications
above, which are made by the app after a successful listing) store a
web-app-written diagnostic line instead, so the error row's **Copy/Download**
always shows something — never a bare 404. Binary failures that produce no
output at all likewise get a single `exit N (no output)` diagnostic line.

### Queue and re-runs

- `max_archive_size` / `min_archive_size` (in bytes; `0` = no limit) are
  enforced while listing — rclone is asked to skip out-of-range files
  (`--min-size`/`--max-size`) and the app re-checks as a backstop — so
  out-of-range archives are ignored entirely (never inserted into the
  queue) and re-evaluated on every run. A limit is also enforced again when
  a run selects queued rows, so rows queued before the limits were set are
  skipped too. An archive sized exactly at a limit is kept.
- `queue_max` (clamped to a positive integer) caps both how many paths are
  accepted while listing and how many queued rows are selected for a run.
- New paths are added as `queued`. Archives whose path lives under
  `trash_subdir` are ignored both while listing and when the run selects
  queued rows, so they are never (re-)processed.
- A path already marked `done` that appears in
  the listing again is treated as a new upload and re-queued — the original
  archive is moved to trash on processing, so a reappearing path is a fresh
  file. A reappearing path previously classified as
  a torrent or website dump is likewise skipped by default (see
  `auto_skip_known`).
- **Start** re-queues archives in the `failed` state and clears their
  `error_kind`. Stale `extracting` rows are also recovered on boot/Start
  (re-queued with `resume` on, marked `killed` with it off). Recovery is
  heartbeat-based: a run is only treated as crashed once its heartbeat
  (`runs.last_touch_at`, bumped while the engine lists, inspects and
  extracts/promotes/moves) is older than 10 minutes — a second instance
  pointed at the same shared Postgres during a rolling deploy or as a
  replica never closes or re-queues a live peer's run; a run abandoned by a
  crashed peer is reclaimed on the next boot/start or, at the latest, by a
  one-shot 10-minute re-check the process schedules on finding fresh rows.
- **Stop** sits at the right edge of the controls row and asks for
  confirmation first (just the two choices): **Soft stop** lets the
  current archive finish; **Hard
  stop** kills the in-flight rclone process immediately, re-queues the
  interrupted archive (never counted as done/failed/skipped) and ends the run
  with `outcome = interrupted`. The panel shows a persistent "Stop requested" message while
  a soft stop is pending.
- **Skip** controls appear in the same row, only while they apply to an
  operation actually in flight, and are never persisted: **Skip listing**
  (only while the listing binary is running) stops the scan early and builds
  the queue from the archives already stored; **Skip inspection** (only
  while an archive is being inspected) treats the inspection as passed and
  extracts the archive; **Skip archive** (only while an archive is in
  flight) stops the current archive and leaves it queued — it is retried on
  the next run, and is counted as skipped for this run's counters. A skip
  affects only the archive/stage in flight — never subsequent archives,
  later runs, or the queue order. A skip asked while nothing matching is in
  flight is refused with a toast instead of being silently dropped.
  Skipping an archive never moves it to the trash folder.
- **Cached scan results are reused automatically.** When the last scan
  completed and the configuration has not changed since, the run rebuilds the
  queue from the archives already stored in the database instead of
  rescanning the remote. Any configuration change, incomplete cache, or
  missing cache falls back to a fresh scan. The cached data itself is never
  modified or deleted.
- All action buttons share the same feedback: a spinner and disabled state
  while the request is in flight, then a toast (via the `HX-Trigger` response
  header) reporting the outcome.
- An archive becomes `done` only when extract, promote, cleanup, and trash all
  succeed. Cleanup failure is logged as a warning; extract, promote, or trash
  failure marks the archive `failed`. A run stopped by the user ends with
  `outcome = interrupted` (``interrupted = 1``) and ends with **Interrupted**
  shown in the UI; a run the host stops (crash, SIGKILL/OOM, or `SIGTERM`/
  `SIGINT` at shutdown) ends with `outcome = killed` (**Killed**), and a run
  the app itself fails ends with `outcome = error` and an `error_kind` code
  (**Error**). App errors never show as Interrupted or Completed. User stops
  are likewise recorded with a code — `interrupted_soft`, `interrupted_hard`,
  or `interrupted_cancel` — in both the run log and the errors log. The cause
  (or code) and time are recorded on the run and shown on both the progress
  and logs pages (e.g. `stopped by user (hard stop)`,
  `received SIGTERM (deploy or restart)`, or `previous process exited mid-run
  (crash or kill)` detected at the next boot); the progress page also shows
  the **Ended** time when a run is not running.

### Continue previous task (resume)

- On **boot** and on **Start**, archives left in `extracting` by a crash are
  handled again (when `resume` is on): they are reset to `queued`.
- When `resume` is off, those archives are instead marked `failed` with
  `error_kind = killed`, so they never sit in `extracting` forever. They
  show up on the Errors page and are re-queued on the next **Start** like any
  other failed archive.
- A run left unfinished (crash, hard kill, or the process receiving
  `SIGTERM`/`SIGINT` mid-run) is closed with `outcome = killed`, `interrupted = 1`,
  and a recorded cause and time — a graceful stop records
  `received SIGTERM/SIGINT` at the moment it happens; a hard kill is recorded
  at the next boot instead. The cause and time are shown on the progress and
  logs pages, and a `[killed] <cause>` line is appended to the run's log and
  errors log. The same code (`killed`, `interrupted_soft`, `interrupted_hard`
  or `interrupted_cancel`) is stored on the run as `error_kind` and shown
  next to the reason on both pages. The progress page also shows the
  **last archive** and **last command** of the interrupted/killed run (the
  slots read "Current archive" and "Active command" while a run is live).
- An **app-caused error** (misconfiguration, a listing failure the app
  surfaces as an exception, a database error) closes the run with
  `outcome = error` and an `error_kind` code — `no_scan_root`,
  `invalid_trash_subdir`, `invalid_tmp_dir`, `listing_failed`, or
  `engine_error` — plus log lines in the run's `errors` log. App errors never
  show as Interrupted or Completed.

This makes an interrupted or killed run safe to resume by simply restarting
the app.

### Browser navigation

Navigating away with the URL bar's **Back/Forward** buttons never stops a
run. Stop and Skip are POST-only endpoints (plus CSRF) and the run executes
server-side, so no history entry can trigger them. Pages are served with
`Cache-Control: no-store`, and a page restored from the back-forward cache
reloads itself instead of showing a stale run state — clicking a stale Stop
button is not possible.

### Authentication & sessions

- Sign-in is password-only (`APP_PASSWORD`); sessions are stored server-side
  in the `sessions` table and the cookie holds a signed session id.
- **Sign out** revokes the current session immediately.
- Sessions expire after 7 days; expired rows are purged on login.
- All mutating routes require a CSRF token (derived from the session, sent as
  `X-CSRF-Token` from htmx or a hidden `csrf_token` field in plain forms).
  `SameSite=Lax` remains as a second layer.
- The login throttle is best-effort and per-IP (5 failures / 10 minutes). It
  uses the socket IP unless `TRUST_PROXY=1`, in which case it trusts the
  first `X-Forwarded-For` entry — set that only behind a proxy that sets it.
  When `TRUST_PROXY=1`, a client can spoof `X-Forwarded-For` and defeat the
  per-IP throttle entirely; prefer adding a network-level rate limit in
  front of the app if you need it.
- Note: sessions did not exist as server-side rows before this; upgrading
  signs everyone out once.

### Logs

The **Logs** page opens on the current (latest) session. While a task is
running, only that live session is shown. When the app is idle, the same log
window has a session picker so older runs can be viewed without leaving the
page, plus tabs for the run log, the errors log, and the per-archive logs.

- The **Archives** tab lists every archive that run processed — done, failed,
  skipped, or still in progress — with an inline **Log view** (most recent
  300 lines; a link downloads the full extraction log), a **Copy log**
  button and a **Download** button for that archive's raw output. Live
  sessions refresh the list every 2 seconds. **Download all** exports one
  text file with the run log, the errors log and every per-archive log of
  the session, delimited by section headers.

- Polling is **incremental** (`?after=<line-id>`): only new lines are fetched
  and appended, and polling stops as soon as the run finishes — finished
  sessions render statically, so they don't poll at all.
- While a session is live, the run log and the Errors page start in **live
  preview** with a **Live preview** / **Manual view** toolbar toggle.
  Scrolling away from the bottom pauses polling automatically; switching back
  resumes from the last fetched line, so lines already on screen are kept.
  Finished sessions have no polling and no toggle.
- The log view is **mobile-friendly and selectable**: every line is real text,
  you can tap and hold to select parts of it, or use the toolbar buttons
  **Copy all**, **Copy selection**, **Select all** and **Download**.
- **Copy all**/**Download** export the session and tab; **Copy selection**
  copies whatever you have selected; **Select all** selects the whole log for
  partial manual copying. Clipboard fallbacks work on plain-HTTP self-hosted
  deployments too.
- The **Errors** page lists archives with `error_kind` set (except
  password-protected archives, see below) and has a **Copy all** button for a
  tab-separated summary. Each card shows its Queue ID, the failing command and
  the last native error lines it produced, with app-written diagnostics
  filtered out.
  The row's **Copy** / **Download** button fetches the full archive log, where
  a `---` separator and a `$ ` line delimit each command's raw output. The run
  error log also records the redacted command that failed.
- The **Password-protected** section on the Errors page lists every archive
  that reached a run but needs a password (a warning is logged and the run moves
  to the next archive; they are never extracted without one). Each row shows
  the file name and path and its size, a **Log view** for the per-archive
  log, **Copy log**, a **Download** button that streams the archive itself
  through the app (`rclone cat`; it answers HTTP `Range` requests, and
  archives up to 32 MB are served with `Content-Length` so an interrupted
  download resumes in the browser's download manager / `wget -c` /
  `aria2c -c` — larger ones stream chunked with `Content-Range`), and
  **Delete** —
  which moves the file to the configured trash folder after a confirmation
  (never outright deletion, and never over anything already in the trash).
  One archive-file download can stream at a time — app-wide; while one is
  in flight the other **Download** buttons are greyed out and a second request
  is refused with a 409. Skip and stop no longer kill an in-flight download.
  The same file can't be deleted (or restored) while it is streaming. A
  deleted archive shows up on the same tab with an **in trash** pill and a
  **Restore** button that moves it back into the queue (clearing the error
  kind). Restore assumes the file is still in the trash; if it was removed
  from there (by hand, say), the stale entry is dropped instead of failing
  forever. Delete/Restore can be requested while a task is running: the move
  is queued in memory, shown as **pending**, and executed when the current
  archive finishes. A restart discards the queue.

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
  server.ts        entry: init DB, wire routes, listen, then boot checks
  config.ts        env + paths
  crypto.ts        AES-256-GCM secret encryption
  db/              Store interface + sqlite/postgres backends + schema
  log.ts           DB-backed logger + tail/read helpers
  rclone.ts        rclone command wrapper
  archive.ts       name/path helpers, archive content filters, isSupported
  engine.ts        the extract loop, run state, resume
  ui.ts            HTML layout + escaping
  views.ts         UI fragment builders (run controls, Configuration form)
  format.ts        shared byte/duration formatters
  domain.ts        shared path, status and id helpers
  live.ts          live archive state for poll views
  fragmentcache.ts cached poll fragments
  errorrows.ts     error-card rendering (Errors page)
  passwordrows.ts  password-protected rows (Errors page section)
  archiverows.ts   per-run archive rows (Logs page, Archives tab)
  downloads.ts     in-flight archive-download registry
  runs.ts          run-outcome resolution (legacy interrupted-flag fallback)
  routes/
    pages.ts       GET /  /config  /logs  /errors
    auth.ts        login/logout, DB sessions, CSRF middleware
    dashboard.ts   GET /dashboard/fragment (progress panel poll target)
    actions.ts     POST /run/start  /run/stop  /run/skip  /config  /config/rclonex-clear
    logsapi.ts     GET /logs/fragment  /errors/fragment  /logs/archives-fragment  + downloads
    data.ts        POST /export  POST /import
public/
  favicon.svg      r/ monogram icon
  styles.css       design system
  htmx.min.js      vendored htmx
  morphdom-umd.min.js vendored morphdom for targeted DOM updates
  app.js           shared client runtime: toasts, busy state, polling, DOM morphing, modals, config editing
  copy.js          clipboard copy + incremental polling with live-preview toggle
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
GET  /dashboard/queue      paginated queue page (auth)
GET  /logs/fragment        incremental log tail  (auth)
GET  /errors/fragment      error rows           (auth)
GET  /logs/archives-fragment                    (auth, per-run archive rows for the Archives tab)
GET  /download/run/:id/all                       (auth, run log + errors + every archive log as one .txt)
POST /run/start  /run/stop  /run/skip               (auth)
POST /config  /config/rclone-clear  /config/rclonex-clear  (auth)
POST /maintenance/queues  /maintenance/logs  /maintenance/all  /maintenance/tmp-purge  (auth)
GET  /download/run/:id  /download/archive/:id  (auth)
GET  /download/archive-file/:id                   (auth, streams the archive itself; Range-resumable)
GET  /download/archive-file/active                (auth, {"active": n} in-flight archive downloads)
GET  /logs/archive/:id/fragment                   (auth)
POST /archives/:id/delete  /archives/:id/restore  (auth)
POST /export  /import                          (auth)
GET  /healthz              "ok" (no auth)
GET  /public/*             static files (no auth)
```

---

## Backup & restore

On the Configuration page:

- **Export JSON** downloads `settings`, `archives`, `runs`, and
  `log_lines` (capped at 50,000 rows; the export notes `log_lines_truncated`
  when capped). Secrets (`rclone.conf`, `database_url`) are included only if
  you tick *include secrets*; they are re-encrypted with the current key on
  import. A legacy `password` setting in an old export is ignored on import;
  so are the `logs` table rows present in pre-cleanup exports.
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
bun test --isolate
```

To run the app end-to-end locally with a throwaway rclone remote, seeded
archives and a SQLite scratch database, follow
[docs/testing.md](docs/testing.md).

Type checking (`bunx tsc --noEmit`) runs in CI alongside the tests.

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
| Processes | `Bun.spawn` (rclone / rclonex) |
| Encryption | Node `crypto` (AES-256-GCM) |
| UI | htmx 2.0.11 + morphdom 2.7.7, server-rendered |

No bundler, no client framework, no ORM.
