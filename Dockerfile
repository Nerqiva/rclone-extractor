FROM oven/bun:1.4-slim
# BuildKit sets TARGETARCH/TARGETVARIANT when building multi-arch images
# (linux/amd64,linux/arm64). Select the matching rclone instead of always
# hardcoding the amd64 build, which fails with ENOEXEC on arm64 hosts.
ARG TARGETARCH
ARG TARGETVARIANT
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
 && rm -rf rclone-* \
 && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
# Default data directory lives under the app directory, which is owned by the
# runtime user, so SQLite works out of the box even without a mounted volume.
# Pre-create it and give ownership to `bun`. To persist across redeploys either
# mount a volume here (note: a host/Render disk mount is root-owned and may need
# DATA_DIR pointed elsewhere) or use Postgres.
RUN mkdir -p /app/data && chown -R bun:bun /app/data
ENV DATA_DIR=/app/data PORT=8080 TZ=Asia/Omsk
VOLUME /app/data
EXPOSE 8080
USER bun
CMD ["bun","run","src/server.ts"]