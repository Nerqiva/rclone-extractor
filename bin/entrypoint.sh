#!/bin/sh
# Container entrypoint: refresh rclone/rclonex to the latest release
# (best-effort, checksum-verified), then start the app. RCLONE_BIN /
# RCLONEX_BIN set by the operator always win; otherwise the refreshed copies
# under $DATA_DIR/bin are used when present.

BIN_DIR="${DATA_DIR:-/app/data}/bin"
# Per-run private rclone.conf snapshots (see src/rclone.ts writeRunConfSnapshot)
# hold the run's credentials; a hard-crashed run leaves one behind. The app
# deletes its own at run end; nothing can be live in this container yet, so
# clear them here.
rm -f "${DATA_DIR:-/app/data}"/run-conf-*.conf
if ! "$(dirname "$0")/fetch-deps.sh"; then
  echo "bootstrap: refresh failed — continuing with the previous binaries"
fi
if [ -z "${RCLONE_BIN:-}" ] && [ -x "$BIN_DIR/rclone" ]; then
  export RCLONE_BIN="$BIN_DIR/rclone"
fi
if [ -z "${RCLONEX_BIN:-}" ] && [ -x "$BIN_DIR/rclonex" ]; then
  export RCLONEX_BIN="$BIN_DIR/rclonex"
fi
exec "$@"
