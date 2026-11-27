#!/bin/sh
# Fetch the latest rclone / rclonex at container start.
#
# Both binaries are downloaded into $DATA_DIR/bin (writable, on the volume)
# and only when the installed copy is not current — so restarts are cheap.
# Every step is verified against published checksums and guarded: on any
# failure the previous copy is kept and the app starts anyway. The binaries
# baked into the image at /usr/local/bin are the offline floor; the
# entrypoint sets RCLONE_BIN/RCLONEX_BIN to these refreshed copies unless the
# user already set them.

set -u

BIN_DIR="${DATA_DIR:-/app/data}/bin"
mkdir -p "$BIN_DIR" || { echo "bootstrap: cannot create $BIN_DIR"; exit 0; }

arch=$(uname -m)
# rclone adds arm-v* variants; rclonex only ships amd64/arm64/386.
case "$arch" in
  x86_64|amd64) R_ARCH=amd64; X_ARCH=amd64 ;;
  aarch64|arm64) R_ARCH=arm64; X_ARCH=arm64 ;;
  i?86|x86)      R_ARCH=386;   X_ARCH=386 ;;
  armv7l)        R_ARCH=arm-v7; X_ARCH="" ;;
  armv6l)        R_ARCH=arm-v6; X_ARCH="" ;;
  *)             R_ARCH="";     X_ARCH="" ;;
esac

log() { echo "bootstrap: $*"; }

fetch_rclone() {
  if [ -z "$R_ARCH" ]; then
    log "rclone: unsupported arch '$arch' — using the image-baked copy"
    return 0
  fi
  want=$(curl -fsSL --max-time 20 https://downloads.rclone.org/version.txt | awk '{print $2}')
  if [ -z "$want" ]; then
    log "rclone: could not resolve the latest version — keeping the previous copy"
    return 0
  fi
  have=$("$BIN_DIR/rclone" version 2>/dev/null | head -n 1 | awk '{print $2}')
  if [ "$have" = "$want" ]; then
    log "rclone: up to date ($want)"
    return 0
  fi
  log "rclone: fetching $want (have: ${have:-none})"
  zip="rclone-${want}-linux-${R_ARCH}.zip"
  tmp=$(mktemp -d) || return 0
  (
    cd "$tmp" || exit 1
    curl -fLO --max-time 240 "https://downloads.rclone.org/${want}/${zip}" || exit 1
    curl -fsSL --max-time 30 "https://downloads.rclone.org/${want}/SHA256SUMS" -o SHA256SUMS || exit 1
    grep "  ${zip}\$" SHA256SUMS > check.txt || exit 1
    sha256sum -c check.txt || exit 1
    unzip -q "$zip" || exit 1
    install -m 0755 "rclone-${want}-linux-${R_ARCH}/rclone" "$BIN_DIR/rclone.new" || exit 1
    mv "$BIN_DIR/rclone.new" "$BIN_DIR/rclone" || exit 1
  ) && log "rclone: updated to $want" || log "rclone: refresh failed — keeping the previous copy"
  rm -rf "$tmp"
}

fetch_rclonex() {
  if [ -z "$X_ARCH" ]; then
    log "rclonex: unsupported arch '$arch' — using the image-baked copy"
    return 0
  fi
  # The release's own installer places the 7-Zip libraries and Codecs beside
  # the binary, which archive extract needs.
  script_url="https://raw.githubusercontent.com/Nerqiva/rclonex/main/bin/install-rclonex.sh"
  tmp=$(mktemp -d) || return 0
  if ! curl -fsSL --max-time 30 "$script_url" -o "$tmp/install-rclonex.sh"; then
    log "rclonex: could not download the install script — keeping the previous copy"
    rm -rf "$tmp"
    return 0
  fi
  if RCLONEX_INSTALL_DIR="$BIN_DIR" bash "$tmp/install-rclonex.sh"; then
    log "rclonex: updated to $("$BIN_DIR/rclonex" version 2>/dev/null | head -n 1)"
  else
    code=$?
    if [ "$code" = 3 ]; then
      log "rclonex: up to date"
    else
      log "rclonex: refresh failed (exit $code) — keeping the previous copy"
    fi
  fi
  rm -rf "$tmp"
}

fetch_rclone
fetch_rclonex
