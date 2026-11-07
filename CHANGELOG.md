# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses **CalVer** versioning (`YYYY.MM.DD.<counter>`) with an
`-alpha` stability suffix while in development. Releases are published as
GitHub **prereleases** and automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) on every push
to `main`.

## [Unreleased]

### Added
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
- After each processed archive the now-empty per-archive temp directory is
  removed (`rclone rmdir`), and the run-level and global `.rclone-extractor-tmp`
  directories are removed at the end of the run, best-effort. Non-empty
  directories (crashes, partial extracts) are left in place.

### Fixed
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
