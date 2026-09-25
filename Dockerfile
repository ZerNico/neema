# syntax=docker/dockerfile:1

# Production image for the web app. Build from the repository root:
#   docker build -t neema .
# Runtime configuration is the environment in apps/web/.env.example. Migrations
# run on start (set MIGRATE_ON_START=false to run them yourself).

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node

FROM node AS build
WORKDIR /repo
# pnpm advises against corepack, and Node 25+ no longer ships it. The version
# comes from packageManager, so package.json stays the one place it is pinned.
COPY package.json ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
# Lockfile first: the fetched store survives any source change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store --filter "@chat/web..."
RUN pnpm --filter @chat/web build

FROM node AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    BLOB_STORE_ROOT=/data/storage \
    CUSTOM_TOOL_PACKAGE_ROOT=/data/custom-tools
WORKDIR /app
# .output is self-contained: Nitro traced the server's node_modules into it,
# and the build bundled the migrator and copied drizzle/ beside it.
COPY --from=build --chown=node:node /repo/apps/web/.output .output
COPY --from=build --chown=node:node /repo/apps/web/scripts/start.mjs scripts/start.mjs
COPY --chmod=755 infra/production/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
# Liveness only: the shell is served without touching the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.NITRO_PORT}/login`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "scripts/start.mjs"]
