#!/bin/sh
# Container entrypoint: refresh rclone/rclonex to the latest release
# (best-effort, checksum-verified), then start the app. RCLONE_BIN /
# RCLONEX_BIN set by the operator always win; otherwise the refreshed copies
# under $DATA_DIR/bin are used when present.

BIN_DIR="${DATA_DIR:-/app/data}/bin"
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
