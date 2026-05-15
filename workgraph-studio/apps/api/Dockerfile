# Multi-stage build for @workgraph/api.
#
# IMPORTANT: build context must be the workspace ROOT, not apps/api,
# because @workgraph/api depends on workspace packages (@workgraph/shared-types,
# @workgraph/engine). The infra/docker/docker-compose.yml sets:
#   context: ../../        # workgraph-studio root
#   dockerfile: apps/api/Dockerfile

FROM node:22-alpine AS base
RUN apk add --no-cache openssl
RUN npm install -g pnpm@10

FROM base AS deps
WORKDIR /app
# Workspace metadata + lockfiles
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# Per-package manifests (deps install respects only these so we keep cache hot)
COPY apps/api/package.json apps/api/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types
COPY packages/engine ./packages/engine
RUN mkdir -p /docs/data-model
RUN pnpm --filter @workgraph/api exec prisma generate
RUN pnpm --filter @workgraph/api build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
RUN npm install -g pnpm@10

# Bring in the compiled api + the workspace packages it imports at runtime
# (shared-types is referenced via tsconfig path, but the compiled output has
# already inlined the imports — we still need its node_modules entry for any
# runtime require resolution).
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared-types ./packages/shared-types
COPY --from=build /app/packages/engine ./packages/engine

WORKDIR /app/apps/api
EXPOSE 8080
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/apps/api/src/index.js"]
