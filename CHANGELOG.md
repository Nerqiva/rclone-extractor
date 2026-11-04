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
- Pluggable database backends: SQLite (`bun:sqlite`, default) and remote
  **PostgreSQL** (`Bun.SQL`) behind a single async `Store` interface in
  `src/db/`. The backend is selected at startup via `DATABASE_URL`; the schema
  is created automatically on first boot.
- AES-256-GCM encryption for secrets at rest (app password, `rclone.conf`,
  database URL) when `SECRET_KEY` is set, in `src/crypto.ts`. Existing
  plaintext secrets are encrypted automatically on first boot.
- `README.md` with quick start, configuration, persistence model, encryption,
  architecture, and route reference.
- `VERSION` file as the single source of truth for the app version.
- Automated CalVer **alpha prerelease** workflow
  (`.github/workflows/release.yml`): every push to `main` computes
  `YYYY.MM.DD.<counter>-alpha`, syncs the version into `VERSION` and
  `package.json`, and publishes a GitHub prerelease.
- `bunfig.toml` test preload configuration.

### Changed
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

### Removed
- File-based logging (`LOG_DIR` log files) in favour of the `log_lines` table.
- `src/db.ts` (superseded by the `src/db/` module).
