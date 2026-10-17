# SARA web app: Vite build served by nginx, /api proxied to the `server` service.
# Build from the repo root (the pnpm workspace):
#   docker build -f client/Dockerfile -t sara-client .
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@12.11.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile --filter @sara/client
COPY client client
# Vite inlines VITE_* at build time (empty API URL = same origin, which nginx proxies).
ARG VITE_API_URL=
ARG VITE_APP_NAME=SARA
RUN pnpm --filter @sara/client build

FROM nginx:1.29-alpine
# nginx.conf proxies /api to the compose `server` service. The Cloud Run build (client/cloudbuild.yaml)
# passes NGINX_CONF=client/nginx.cloudrun.conf: static files only, the browser calls VITE_API_URL itself.
ARG NGINX_CONF=client/nginx.conf
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"]
