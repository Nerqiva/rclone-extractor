FROM oven/bun:1.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tar gzip \
 && curl -LO https://downloads.rclone.org/rclone-current-linux-amd64.zip \
 && unzip rclone-current-linux-amd64.zip \
 && cp rclone-*-linux-amd64/rclone /usr/local/bin/ \
 && chmod 755 /usr/local/bin/rclone \
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
ENV DATA_DIR=/app/data PORT=8080
VOLUME /app/data
EXPOSE 8080
USER bun
CMD ["bun","run","src/server.ts"]