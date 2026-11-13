FROM oven/bun:1.4-slim
# BuildKit sets TARGETARCH/TARGETVARIANT when building multi-arch images
# (linux/amd64,linux/arm64). Select the matching rclone instead of always
# hardcoding the amd64 build, which fails with ENOEXEC on arm64 hosts.
ARG TARGETARCH
ARG TARGETVARIANT
# rclone and rclonex are installed here as the OFFLINE FLOOR. At every
# container start the entrypoint refreshes both to the latest release
# (bin/fetch-deps.sh) into /app/data/bin — downloads are checksum-verified
# (rclone against downloads.rclone.org's signed SHA256SUMS, rclonex against
# the release's checksums.txt), and any failure keeps the previous binary,
# so the app starts either way. curl/unzip/tar are kept for that refresh.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tar gzip tzdata \
 && ARCH="${TARGETARCH:-amd64}" \
 && case "$ARCH" in \
      amd64) RCLONE_ARCH=amd64 ;; \
      arm64) RCLONE_ARCH=arm64 ;; \
      arm) if [ "${TARGETVARIANT:-}" = "v6" ]; then RCLONE_ARCH=arm-v6; else RCLONE_ARCH=arm-v7; fi ;; \
      386) RCLONE_ARCH=386 ;; \
      *) echo "unsupported TARGETARCH=$ARCH" >&2; exit 1 ;; \
    esac \
 && echo "installing rclone for ${TARGETARCH:-amd64} (${RCLONE_ARCH})" \
 && curl -fsSLO "https://downloads.rclone.org/rclone-current-linux-${RCLONE_ARCH}.zip" \
 && unzip "rclone-current-linux-${RCLONE_ARCH}.zip" \
 && cp rclone-*-linux-${RCLONE_ARCH}/rclone /usr/local/bin/rclone \
 && chmod 755 /usr/local/bin/rclone \
 && rclone version \
 && curl -fsSL https://raw.githubusercontent.com/Nerqiva/rclonex/main/bin/install-rclonex.sh | bash || { code=$?; \
      if [ "$code" = "3" ]; then echo "rclonex is already the latest release (continuing)"; \
      else echo "rclonex installation failed (exit $code) — aborting build" >&2; exit "$code"; fi; } \
 && rclonex version \
 && rm -rf rclone-* \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
# Default data directory lives under the app directory, which is owned by the
# runtime user, so SQLite works out of the box even without a mounted volume.
# Pre-create it and give ownership to `bun`. To persist across redeploys either
# mount a volume here (note: a host/Render disk mount is root-owned and may need
# DATA_DIR pointed elsewhere) or use Postgres.
# The app passes --config ${DATA_DIR}/rclone.conf to every rclone invocation, so
# /app/data must be writable for a stored rclone.conf working copy (when it is
# not, the working copy falls back to /tmp/app/data). Mount your own
# rclone.conf read-only at /app/data/rclone.conf to use it as-is.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
ENV DATA_DIR=/app/data PORT=8080 TZ=Asia/Omsk
VOLUME /app/data
EXPOSE 8080
USER bun
# The entrypoint refreshes rclone/rclonex to the latest release at every
# container start (best-effort, checksum-verified) and then execs the app.
ENTRYPOINT ["/app/bin/entrypoint.sh"]
CMD ["bun","run","src/server.ts"]