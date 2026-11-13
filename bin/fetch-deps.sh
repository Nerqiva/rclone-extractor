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
  # Latest stable release, falling back to the newest pre-release (all of
  # rclonex's current releases are pre-releases).
  json=$(curl -fsSL --max-time 20 https://api.github.com/repos/Nerqiva/rclonex/releases/latest 2>/dev/null) \
    || json=$(curl -fsSL --max-time 20 "https://api.github.com/repos/Nerqiva/rclonex/releases?per_page=1" 2>/dev/null)
  if [ -z "$json" ]; then
    log "rclonex: could not query releases — keeping the previous copy"
    return 0
  fi
  tag=$(printf '%s' "$json" | grep -m1 -o '"tag_name":[^,]*' | cut -d'"' -f4)
  if [ -z "$tag" ]; then
    log "rclonex: could not parse the release tag — keeping the previous copy"
    return 0
  fi
  have=$(cat "$BIN_DIR/.rclonex-tag" 2>/dev/null)
  if [ "$have" = "$tag" ] && [ -x "$BIN_DIR/rclonex" ]; then
    log "rclonex: up to date ($tag)"
    return 0
  fi
  log "rclonex: fetching $tag (have: ${have:-none})"
  asset="rclonex_linux_${X_ARCH}.tar.gz"
  base="https://github.com/Nerqiva/rclonex/releases/download/${tag}"
  tmp=$(mktemp -d) || return 0
  (
    cd "$tmp" || exit 1
    curl -fLO --max-time 240 "${base}/${asset}" || exit 1
    curl -fsSL --max-time 30 "${base}/checksums.txt" -o checksums.txt || exit 1
    grep "${asset}" checksums.txt | sha256sum -c - || exit 1
    tar -xzf "$asset" || exit 1
    install -m 0755 rclonex "$BIN_DIR/rclonex.new" || exit 1
    mv "$BIN_DIR/rclonex.new" "$BIN_DIR/rclonex" || exit 1
    printf '%s' "$tag" > "$BIN_DIR/.rclonex-tag"
  ) && log "rclonex: updated to $tag" || log "rclonex: refresh failed — keeping the previous copy"
  rm -rf "$tmp"
}

fetch_rclone
fetch_rclonex
