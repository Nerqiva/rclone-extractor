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
# /data is the recommended path for a mounted volume. Pre-create it and give
# ownership to the runtime user so a freshly-created directory is writable even
# before a volume is attached. (A host-mounted volume may still be root-owned;
# set DATA_DIR to a writable path or run as root in that case.)
RUN mkdir -p /data && chown -R bun:bun /data
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
USER bun
CMD ["bun","run","src/server.ts"]