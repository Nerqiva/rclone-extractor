# AGENTS.md — rules for AI coding agents working in this repo

Any AI agent (OpenCode, Claude Code, Cursor, Copilot, …) working here
must follow these norms. Humans welcome too. If something here conflicts
with a direct instruction from the maintainer, the instruction wins.

## What this project is

`rclone-extractor` is a small self-hosted web app that scans an
[rclone](https://rclone.org) remote for archives, extracts them **in
place**, promotes the results up a directory, and moves the archive to a
trash folder. It ships with a live progress page, a configuration page,
and log/error views. See `README.md` for users and `CHANGELOG.md` for the
history of every change.

Stack: **Bun** (runtime + `bun:sqlite`), **Hono**, server-rendered HTML
with **htmx** (vendored at `public/htmx.min.js`). No bundler, no client
framework, no ORM. TypeScript is run directly — do not add a build step
or a client-side framework.

## Commands

```bash
bun install            # install dependencies (CI uses --frozen-lockfile)
bun run src/server.ts  # run the app (needs APP_PASSWORD, e.g. dev creds)
bun test --isolate     # run the test suite (CI uses --isolate)
```

The suite includes a **documentation drift guard** (`tests/readme.test.ts`):
it fails if any registered route, environment variable, or user-facing
setting is missing from `README.md` (or if the documented route list
mentions an endpoint that no longer exists). **Update README.md whenever
you add/remove an endpoint, env var, or setting.**

## Step-by-step workflow

1. **Plan first.** Read the task and the code it touches. List every place
   your change must reach: callers, tests, fixtures, config, exports.
   Understand what the change could break before editing.
2. **Smallest sufficient change.** Prefer deleting over adding. Do not add
   dependencies, abstractions, options, or config that were not asked for.
3. **Run the tests before committing.** `bun test --isolate` must be green.
   If it is red before you start, say so instead of fixing unrelated tests.
4. **User-facing changes go in three places:** `src/`, `tests/` (or
   fixtures/mocks), and `README.md` + `CHANGELOG.md` (Keep a Changelog
   format, unreleased section). The readme drift guard will fail otherwise.
5. **Verify honestly.** Say what you only checked by reading vs. by
   running. Flag what you skipped.

## Commit style

- Messages: `feat|fix|chore|perf|refactor|docs|test|build(<scope>): <what>` —
  look at `git log` for the house style.
- **Never** add `[skip ci]` yourself — that marker is reserved for the
  release bot (see below).
- **Never** edit the `VERSION` file or the `version` field in
  `package.json` by hand. That belongs to the release bot.
- Keep each commit one coherent change; don't mix refactors with behavior
  changes.

## Code style

- TypeScript, run directly by Bun. Keep the same structure, naming and
  patterns as the surrounding code — match before innovating.
- Server-rendered HTML strings built by hand (see `src/ui.ts`,
  `src/routes/*.ts`); escaped with `esc()` from `src/ui.ts`. Client side is
  vanilla JS + htmx — keep the `hx-*` pattern used elsewhere.
- Comment only the *why* the code cannot show, in one line.
- Smallest diff that works; no backwards-compatibility shims for code
  nobody uses (deletion beats addition).
- Tests live in `tests/*.test.ts`, run in isolation; new non-trivial logic
  needs a test. Mock rclone/rclonex via shell scripts in a temp dir — never
  shell out to the real binaries or network in tests.

## Security invariants (never weaken these)

- Every path passed to rclone is validated with `isSafeRel` /
  `assertSafeRel` (rejects absolutes, `..`, empty segments). No exceptions.
- All mutating routes are CSRF-protected (`csrfMiddleware`); htmx sends the
  token from the `<meta name="csrf-token">` header. Destructive actions
  additionally go through the shared confirm modal (`data-confirm`).
- Secrets (`rclone.conf`, database URL, `rclonex_archive_password`) are
  encrypted at rest with AES-256-GCM when `SECRET_KEY` is set — never log
  them, never render them.
- Per-archive logs hold **raw binary output only** — no app wording. App
  diagnostics for webapp failures go through `appendRawLines` as neutral
  one-liners; user-facing toasts carry `HX-Trigger`.
- `dry_run` is honored by every destructive operation.
- Skip state is **never persisted** — skips are per-run, in-memory only.
- The archive file is never deleted outright by the app: "Delete" means
  *move to the trash subdir*; trash moves refuse to overwrite.

## Release flow (what happens on push to `main`)

- On every push to `main`, `.github/workflows/release.yml` computes the
  next CalVer version (`YYYY.MM.DD.<n>-alpha`), commits a
  `chore(release): … [skip ci]` bump to `VERSION` and `package.json`,
  tags `v<version>`, and publishes a GitHub **prerelease**.
- On pushes to `main` and `v*` tags, `.github/workflows/ci.yml` runs the
  tests and builds/pushes the multi-arch Docker image to GHCR.
- Agents must not "help" by bumping versions, tagging releases, or adding
  `[skip ci]` — the bot owns that flow.

## Things agents commonly get wrong

- Editing `tests/` to make them pass. Fix the code, or if the test is
  genuinely wrong, say so and edit it in the same PR with a reason.
- Adding dependencies for a few lines — write the few lines.
- Forgetting the README/CHANGELOG pair, which the drift guard enforces.
- Touching the `runs` schema without a migration in `src/db/index.ts` —
  schema changes need an idempotent `migrate*` function called from
  `initDbOnce()`.
- Assuming Interrupted vs Killed vs Error mean the same thing — they are
  distinct (`interrupted` = user stop, `killed` = host lost the process,
  `error` = app-caused failure) and map to different `error_kind` codes.
