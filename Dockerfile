# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 needs prebuilt binaries from npm ci stage; copy node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data \
 && chown -R node:node /app

# Entrypoint starts as root only to chown the mounted data dir, then the
# server process itself runs as the unprivileged `node` user.
ENV DATA_DIR=/app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.js"]
