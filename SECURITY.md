# Security Policy

## How to report

Please report security problems privately through GitHub private security
advisories:

https://github.com/Nerqiva/rclone-extractor/security/advisories/new

Do not open a public issue for a security problem. Include steps to
reproduce, the impact, and the version you are running. You should get a
response within a few days.

## Scope

In scope: this app (rclone-extractor) — the web UI, the server, the job
engine, the database layer, and the Docker image built from this repo.

Out of scope:

- rclone and rclonex themselves (report upstream)
- Your hosting provider, reverse proxy, or network setup
- Issues that require an already-compromised host or leaked credentials

## Supported versions

Only the latest CalVer prerelease release is supported. Older builds do
not receive fixes.

## Secrets

How `APP_PASSWORD` and `SECRET_KEY` are handled (login password read from
the environment, secrets encrypted at rest with AES-256-GCM when
`SECRET_KEY` is set) is documented in `README.md`. Please read that
before reporting a "secrets stored in plaintext" issue.
