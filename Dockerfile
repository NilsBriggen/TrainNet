FROM oven/bun:1.4-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip gdal-bin && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY server server
COPY scripts scripts
COPY public public
RUN mkdir /data && chown bun /data
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
USER bun
CMD ["bun", "server/index.ts"]
