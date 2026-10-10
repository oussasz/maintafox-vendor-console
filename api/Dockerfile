# syntax=docker/dockerfile:1
# Build from repository root: `docker compose build api` (see docker-compose.yml `context: .`).
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
RUN pnpm install --frozen-lockfile --filter maintafox-control-api

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=deps /app /app
COPY api/tsconfig.json ./api/
COPY api/src ./api/src
RUN pnpm --filter maintafox-control-api run build

FROM node:20-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY api/package.json ./api/
RUN pnpm install --frozen-lockfile --filter maintafox-control-api --prod

FROM node:20-alpine
WORKDIR /app/api
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY --from=prod-deps /app /app
COPY --from=build /app/api/dist ./dist
COPY api/migrations ./migrations
# Sync entity registry (protocol v2), resolved from dist/sync as ../../../shared.
COPY shared/sync-entity-registry.v2.json /app/shared/sync-entity-registry.v2.json
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
