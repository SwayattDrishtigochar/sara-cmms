# SARA API. Build from the repo root (the pnpm workspace):
#   docker build -f server/Dockerfile -t sara-server .
# Runtime needs Node >= 22 (process.loadEnvFile, Map.groupBy); dev tooling needs >= 22.12 (vitest, jsdom).
# The image uses 26, the version dev and CI run.
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS deps
# Node 26 ships without corepack: install the pnpm version pinned in package.json#packageManager.
RUN npm install -g pnpm@12.11.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile --prod --filter @sara/server

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production PORT=5080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/
COPY server/src server/src
COPY server/scripts server/scripts
WORKDIR /app/server
USER node
EXPOSE 5080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.js"]
