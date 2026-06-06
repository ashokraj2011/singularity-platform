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
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && { pnpm install --frozen-lockfile || pnpm install; } \
 && rm -f .npmrc

# ── dev target ────────────────────────────────────────────────────────────
# Hot-reload runtime. apps/api/src + prisma + workspace packages are expected
# to be bind-mounted from the host; package.json's `dev` script runs
# ts-node-dev --respawn so edits land without a container rebuild. The
# initial COPY of source exists so `pnpm dev` has something to run on first
# boot before the host bind-mount overlays it.
FROM base AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types
COPY packages/engine ./packages/engine
# Generate ONLY the Prisma client. The schema also declares an `erd_md`
# generator (prisma-erd-generator) for the docs-only ERD at
# docs/data-model/04-workgraph.md — but it pulls in puppeteer/mermaid-cli,
# whose install scripts pnpm@10 blocks by default, so the module is absent in
# clean image builds and an unfiltered `prisma generate` fails. The ERD is not
# needed in the image; regenerate it locally with
# `pnpm --filter @workgraph/api prisma:erd`.
RUN pnpm --filter @workgraph/api exec prisma generate --generator client
WORKDIR /app/apps/api
EXPOSE 8080
# dev image: apply migrations, then seed the demo data (agents + SDLC/bug-fix +
# sample workflows + a completed blueprint session with artifacts). Idempotent
# upserts (prisma/seed.ts → seed-demo-workflows.ts), best-effort so a seed hiccup
# never blocks the API from starting. Runs via ts-node, present in this dev image.
# (The prod stage ships compiled JS without ts-node, so it is NOT seeded here.)
CMD ["sh", "-c", "npx prisma migrate deploy && (npx prisma db seed || echo 'seed skipped/failed (non-fatal)') && pnpm dev"]

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types
COPY packages/engine ./packages/engine
# ERD generator is dev-only (see dev stage); image build runs only `client`.
RUN pnpm --filter @workgraph/api exec prisma generate --generator client
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
