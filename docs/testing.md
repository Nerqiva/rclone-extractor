# Local smoke-test setup

How to run the app locally end-to-end with a throwaway rclone remote and
seeded archives — the same setup used during development. Everything lives
under one scratch directory; deleting it removes all traces (database,
logs, extracted files, trash).

Requires: `bun`, `rclone`, `python3`, and a free port.

## 1. Scratch layout

```bash
SCRATCH=$(mktemp -d /tmp/opencode/rx-test-XXXX)
mkdir -p "$SCRATCH/scan/incoming" "$SCRATCH/data"
printf '[localtest]\ntype = local\n' > "$SCRATCH/data/rclone.conf"
```

## 2. Seed archives

`python3 -m zipfile` can create everything you need:

```python
import zipfile, os
root = "<SCRATCH>/scan/incoming"
payload = os.urandom(300 * 1024)          # big enough to avoid the tiny filter
with zipfile.ZipFile(root + "/photos-backup.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("photos/IMG_0001.bin", payload)
    z.writestr("photos/readme.txt", "family photos\n" * 10)
with zipfile.ZipFile(root + "/tiny-bits.zip", "w") as z:
    for i in range(5):
        z.writestr(f"bit{i}.txt", "x" * 100)   # skipped: tiny
with zipfile.ZipFile(root + "/site-backup.zip", "w") as z:
    z.writestr("index.html", "<html></html>")  # skipped: website dump
    z.writestr("styles.css", "body{}")
    z.writestr("app.js", "console.log(1)")
with zipfile.ZipFile(root + "/empty-dump.zip", "w"):
    pass                                      # skipped: unreadable
with open(root + "/broken-download.zip", "wb") as f:
    f.write(b"PK\x03\x04" + b"\x00" * 60)     # skipped: unreadable
```

Expected result after one run: `photos-backup` done (archive ends up in
`incoming/trash/`), the rest skipped with reasons `tiny` / `website` /
`unreadable`.

## 3. Run the app

```bash
cd <repo>
DATA_DIR="$SCRATCH/data" APP_PASSWORD=dev-pw SECRET_KEY=dev-secret \
  COOKIE_SECURE=0 BIND=127.0.0.1 PORT=8123 bun run src/server.ts
```

`COOKIE_SECURE=0` is required because this is plain HTTP on localhost.

Set the scan root once (either through the Configuration page, or directly):

```bash
DATA_DIR="$SCRATCH/data" bun -e "import { initDb, setSetting } from './src/db/index.ts'; \
  await initDb(); await setSetting('scan_root', 'localtest:$SCRATCH/scan/incoming');"
```

Then open http://127.0.0.1:8123, sign in with `dev-pw`, press **Start**.

## 4. Cleanup

Stop the server (Ctrl-C or SIGTERM), then:

```bash
rm -rf "$SCRATCH"
```

The SQLite database, logs, rclone local remote, and extracted files are all
inside `$SCRATCH`. Nothing else on the machine is touched.

## What this does not cover

- **Password-protected archives** — no local tool can create one here
  (rclonex/7z absent); covered by `tests/passwordtab.test.ts` instead.
- **RAR/7Z/ISO extraction** — requires rclonex on the machine; covered by
  the stub-binary integration tests (`tests/rclonex.test.ts`).
- **Real pixel screenshots** — Playwright with Chromium can capture them,
  but they are not wired into the test suite here.

## Automated tests

`bun test --isolate` — the suite mocks rclone/rclonex with shell stubs in a
temp dir, so it never needs a real remote.
