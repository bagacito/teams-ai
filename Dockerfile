# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The msteams-mcp session store is encrypted with a key derived from
# hostname:username (see src/auth/crypto.ts in msteams-mcp). To decrypt the
# session created on the host, the container must run with the SAME username
# and hostname as the host machine. Configure via build args / compose.
ARG APP_USER=vnogueira
ARG APP_UID=1001
ARG APP_GID=1001
RUN groupadd -g ${APP_GID} ${APP_USER} 2>/dev/null; useradd -m -u ${APP_UID} -g ${APP_GID} ${APP_USER} 2>/dev/null; true

# better-sqlite3 needs prebuilt binaries from npm ci stage; copy node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data /app/teams-session \
 && chown -R ${APP_UID}:${APP_GID} /app

# Entrypoint starts as root only to chown the mounted dirs, then the server
# process runs as the unprivileged app user (identity must match the host's
# for msteams-mcp session decryption — see APP_* build args).
ENV DATA_DIR=/app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/server.js"]
