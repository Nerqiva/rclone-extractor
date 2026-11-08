# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses **CalVer** versioning (`YYYY.MM.DD.<counter>`) with an
`-alpha` stability suffix while in development. Releases are published as
GitHub **prereleases** and automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) on every push
to `main`.

## [Unreleased]

### Security
- Session cookies are now `Secure` (HTTPS-only) by default (`COOKIE_SECURE=0`
  opts out for plain-HTTP deployments), login sessions expire after 7 days
  (expiry is verified server-side, not just via cookie max age), and `POST
  /login` is rate-limited per source IP (5 failures → 10-minute lockout,
  HTTP 429 + `Retry-After`).
- `database_url` on the Configuration page is rendered with credentials
  masked instead of decrypted in full.
- Unauthenticated htmx/fetch requests receive HTTP 401 instead of a silent
  redirect to `/login`.
- `rclone.conf` working copy is written atomically with mode `0600`;
  `DATA_DIR` is created with mode `0700`.

### Fixed
- **Postgres connection exhaustion** (`53300: remaining connection slots are
  reserved for roles with the SUPERUSER attribute`): the app now opens at
  most `PG_POOL_MAX` connections (default 4), recycles idle connections after
  20 s, closes the pool on `SIGTERM`/`SIGINT` (deploys no longer leak
  backends), and retries database initialization a few times with backoff at
  boot instead of crash-looping the service.
- End-of-run cleanup no longer `rclone purge`es the shared temp root (it may
  contain user-owned entries); only the current run's own directory is ever
  purged, and only when it is strictly inside the configured temp root.
- `tmp_dir` validation now rejects `/`, bare remotes (`remote:`), drive
  roots, and absolute temp dirs that overlap the scan root or trash dir.
- `trash_subdir` is validated as a safe relative path (no absolute paths,
  `..`, or special segments), on save and at run start.
- Paths from remote listings are validated before use; `..`/absolute/empty
  segments are skipped (or fail the archive with `unsafe_path`) instead of
  reaching `extract`/`trash`/`promote`.
- Crash-safe force-stop: a force-stopped archive is only re-queued when its
  terminal state had not committed yet (`done`/`skipped` are preserved), and
  a force-stop during listing is treated as "cancelled", not "listing
  failed".
- Backup import is transactional, validates every record before writing
  anything, restores the `logs` table, restores rows under their original
  ids, resets Postgres sequences (`setval`) after restore, skips blanked
  secret values from non-secret exports (importing a safe backup no longer
  wipes stored credentials), and does not duplicate `log_lines` on
  re-import. Backup export now uses deterministic `ORDER BY id`.
- `INSERT OR REPLACE INTO archives` on Postgres now upserts `ON CONFLICT
  (path)` instead of a non-matching `id` target.
- SQLite runs with `PRAGMA busy_timeout=5000`.
- The cancel flag is polled at most twice per second in the hot listing loop
  instead of once per listed line.
- `/download/run/:id` and `/download/archive/:id` reject non-integer ids
  (was: 500 on Postgres, silent empty 404 on SQLite); error rows are capped
  at 500 entries; log downloads are capped at 50 000 lines.
- `archives`/`stem()` sanitize archive basenames that produce empty or
  dot-only temp directory names.

### Added
- `PG_POOL_MAX` and `COOKIE_SECURE` environment variables (see README and
  `.env.example`), plus Postgres connection troubleshooting docs for hosted
  databases (pooler setup, `max_connections`, ECONNREFUSED/53300).
- `tests/data.test.ts`: export→wipe→import round trip (ids preserved,
  secrets preserved, re-import idempotent, malformed records rejected).
- `TZ=Asia/Omsk` in the Docker image (with `tzdata` installed).
- **Progress page** replacing the old Dashboard. It shows a run status badge,
  KPI cards (done, failed, skipped, remaining), a segmented progress bar, and a
  detail grid with the current archive, active command, stage, rate, and ETA.
- **Session-aware Logs page.** The log window opens on the current run while a
  task is live, and offers a session picker for older runs plus Run log /
  Errors tabs and per-session downloads when idle.
- **Command logging.** Every rclone invocation is recorded in the run log and
  the relevant per-archive log; failures also include the command and output in
  the errors log. Sensitive flag values are redacted.
- `APP_PASSWORD` status is shown on the Configuration page.
- Base64-encoded rclone config support. The new `RCLONE_CONF` environment
  variable and the Configuration page's `rclone_conf` editor both accept a
  base64 `rclone.conf`; legacy plain INI values keep working.
- Edit-in-place rows on the Configuration page. Each setting shows its current
  value with an **Edit** button that unfolds the input, while `remote_flags`
  stays permanently visible.
- Import/export now show an inline spinner and toast instead of navigating to a
  result page.
- Pluggable database backends: SQLite (`bun:sqlite`, default) and remote
  **PostgreSQL** (`Bun.SQL`) behind a single async `Store` interface in
  `src/db/`. The backend is selected at startup via `DATABASE_URL`; the schema
  is created automatically on first boot.
- AES-256-GCM encryption for secrets at rest (`rclone.conf`, database URL)
  when `SECRET_KEY` is set, in `src/crypto.ts`. Existing plaintext secrets are
  encrypted automatically on first boot.
- `README.md` with quick start, configuration, persistence model, encryption,
  architecture, and route reference.
- `VERSION` file as the single source of truth for the app version.
- Automated CalVer **alpha prerelease** workflow
  (`.github/workflows/release.yml`): every push to `main` computes
  `YYYY.MM.DD.<counter>-alpha`, syncs the version into `VERSION` and
  `package.json`, and publishes a GitHub prerelease.
- `bunfig.toml` test preload configuration.
- **Content filters before extraction.** Every archive is inspected with
  `rclone archive list --files-only`; archives that are `empty` (no files),
  `torrent` (≥60% `.torrent`), `website` (≥1 website marker and ≥20% of files
  <100KB), `tiny` (≥60% of files <20KB), or `unreadable` (listing fails) are
  skipped and never extracted. Matching is case-insensitive, sizes use 1024-byte
  KB, and directories are excluded. Skipped archives stay skipped on later runs.
- Archives under `trash_subdir` are ignored while building the queue and when a
  run selects queued rows, preventing re-processing of already-trashed files.
- **`max_archive_size` setting on the Configuration page.** A per-archive size
  limit, entered in MB or GB (stored in bytes, `0` = no limit). Archives
  larger than the limit are ignored while listing — never queued, not
  stored — and are re-evaluated on every run, so raising the limit takes
  effect immediately. Rows queued before the limit was set are also skipped
  when a run selects its queue.
- After each processed archive the now-empty per-archive temp directory is
  removed (`rclone rmdir`), and the run-level and global `.rclone-extractor-tmp`
  directories are removed at the end of the run, best-effort. Non-empty
  directories (crashes, partial extracts) are left in place.
- **Live per-extraction progress** on the Progress page. The
  `--stats-one-line` output of `rclone archive extract` is parsed as it streams:
  under the overall progress bar a slim "Current extraction" meter shows bytes
  done/total, percent, transfer speed, and rclone's ETA. The once-per-second
  stats lines are filtered out of the archive log; the command line and all
  other output are still logged.
- **Two-step Stop.** **Stop** is now an explicit soft stop: the button flips to
  **Force stop** and a persistent message shows that the current archive will
  finish first (in the controls and in the polling progress panel). Clicking
  **Force stop** kills the in-flight rclone process immediately (SIGKILL of all
  child processes the app tracks); the interrupted archive is reset to `queued`
  instead of being counted as done/failed/skipped, and the run ends in the
  `cancelled` stage.
- **Configurable temporary extraction directory (`tmp_dir`).** A new
  Configuration setting controls where rclone extracts archives before
  promotion. A relative path resolves inside `scan_root` (unchanged default
  `.rclone-extractor-tmp`); absolute paths (`remote:path/to/dir` or
  `/abs/local/path`) are supported for extracts elsewhere. The engine now
  validates the setting up front and refuses to overlap it with the scan root
  or the trash directory.
- **Automatic stale-temp cleanup.** App-owned stale directories (numeric
  run/archive dirs inside `tmp_dir`) are purged at boot, at the start of every
  run, and at the end of a run (old `rmdir` now falls back to `purge` for
  non-empty dirs). Non-app entries are left alone. `dry_run` disables
  destructive cleanup entirely, and a **Purge temp directory** button on the
  Configuration page runs the same sweep on demand.
- **Uniform button feedback.** Every server-action button shows a spinner and
  disabled state while its request is in flight, and server responses raise a
  toast via the `HX-Trigger` response header (`{"appToast":{message,kind}}`).
  Toasts and the loading state are wired up once globally for all pages
  (`src/ui.ts`).
- **Crashed runs are marked as interrupted.** The `runs` table gained an
  `interrupted` flag (migrated automatically on boot, SQLite and PostgreSQL) set
  by crash recovery; the Progress and Logs pages show such runs as
  **Interrupted** instead of *Completed* / *Finished*.

### Fixed
- **Stage section cleanup.** The unreachable `searching` stage (assigned and
  then overwritten before any I/O) was removed; the detail-grid "Stage" row
  (identical to the header badge) was removed; the `error` stage badge is now
  labelled "Error" rather than "Failed" to avoid clashing with the per-archive
  counter; the run-level Rate/ETA rows carry tooltips describing what they
  measure; the redundant running/finished elapsed-time branch in the panel was
  simplified; and interrupted runs restored from the database no longer render
  as "Completed".
- **Runs cancelled while the last archive was being processed ended as
  "Completed".** The stop decision is now taken after the loop, so any run that
  exits because the user asked to stop (soft or forced) is marked `cancelled`.
- **Stop button gave no feedback.** The controls fragment now re-renders for as
  long as a stop is pending (auto-polling), disabling the action and restoring
  **Start** automatically when the run actually exits.
- **Promotion no longer fails on nested destinations.** `rclone move` rejects
  moving a directory into a parent that contains it
  ("can't sync or move files on overlapping remotes"), which is always the
  case here because the extract temp dir lives inside `scan_root`. `promote`
  now passes `--exclude /.rclone-extractor-tmp/**`, excluding the temp dir
  from the destination traversal while still promoting archive contents that
  are themselves named `.rclone-extractor-tmp`.

### Changed
- **Login uses the `APP_PASSWORD` environment variable only.** The stored
  `password` setting was removed from the schema defaults, settings list, and
  import/export flow; a legacy row is deleted on boot. With no `APP_PASSWORD`
  set, login is disabled.
- **The Dashboard is now the Progress page** (`Task progress` heading). The
  internal `/dashboard/fragment` and `/dashboard/controls` endpoints are
  unchanged.
- **Log lines are ordered by insertion id** rather than by `seq`, so live tails
  and downloads stay in the order lines were written. A supporting index was
  added for SQLite and Postgres.
- **Temporary extraction paths include the archive id**
  (`.rclone-extractor-tmp/<runid>/<archiveid>/<stem>`) to prevent collisions
  between archives with the same filename.
- **Queue semantics are explicit.** `queue_max` caps both listing and queue
  selection; `done` paths that reappear are re-queued outside dry-run mode; and
  failed archives are re-queued with a cleared `error_kind` on Start.
- **Configuration page copy is minimal.** Each option now carries a single
  terse, on-point line (description, warning, or example) under its value; the
  long explanatory paragraphs below the form were removed, and the `database_url`
  row was dropped entirely — the active backend type is shown once in the
  `Backend:` header line instead.
- **Archive completion is strict.** A row is marked `done` only when extract,
  promote, cleanup, and trash succeed; cleanup failures are warnings. Cancelled
  runs use the `cancelled` stage, and unfinished runs are closed on boot.
- **Logging is now database-backed.** Log output (run + per-archive) is stored
  in the `log_lines` table instead of on-disk files, so logs persist across
  restarts on ephemeral container filesystems.
- **Database layer restructured** from a single `src/db.ts` into a `src/db/`
  module (`index.ts`, `sqlite.ts`, `postgres.ts`, `schema.ts`) with a small SQL
  dialect layer (`AUTOINCREMENT` → `BIGSERIAL`, `INSERT OR IGNORE` →
  `ON CONFLICT DO NOTHING`, `INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE`,
  `?` → `$n`).
- Engine, rclone wrapper, routes, and data export/import updated to use the
  async store and DB-backed logger.
- CI publishes Docker images tagged `latest` and the CalVer version via
  `docker/metadata-action`, replacing the previous semver tag.

### Fixed
- Archive listing now stops cleanly at the queue limit or on cancel, reports a
  non-zero rclone exit as a listing failure, and surfaces listing stderr as a
  warning instead of silently continuing.
- The Progress panel no longer shows a previous run as indefinitely live: it
  hydrates from the latest run row when the process has no in-memory state.
- Same-named archives extracted in one run can no longer overwrite each other's
  temporary directory.

### Removed
- File-based logging (`LOG_DIR` log files) in favour of the `log_lines` table.
- Stored login password setting (`settings.password`); use `APP_PASSWORD`.
- `src/db.ts` (superseded by the `src/db/` module).
