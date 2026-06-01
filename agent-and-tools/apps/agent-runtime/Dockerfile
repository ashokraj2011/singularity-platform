# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml. This lets `npm install` resolve workspace deps like
# @agentandtools/shared without per-app inlining.
FROM node:20-alpine AS base
WORKDIR /app
# postgresql-client provides `psql` for the M15 post-push SQL hook.
# git is used by the M17 polling worker to clone + diff repositories.
RUN apk add --no-cache openssl postgresql-client git
RUN mkdir -p /docs/data-model

# ── deps ──────────────────────────────────────────────────────────────────
# Install at workspace root so npm resolves @agentandtools/shared via symlink.
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY apps/agent-runtime/prisma         ./apps/agent-runtime/prisma
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --workspaces --include-workspace-root --no-audit --no-fund \
 && rm -f .npmrc
RUN npm run build --workspace=packages/shared
RUN cd apps/agent-runtime && npx prisma generate --generator client

# ── dev ───────────────────────────────────────────────────────────────────
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-runtime ./apps/agent-runtime
# M29 — per-service Prisma client (output = "../generated/prisma-client")
# is gitignored, so carry it over from deps + regenerate to ensure the
# schema in the dev stage matches.
COPY --from=deps /app/apps/agent-runtime/generated ./apps/agent-runtime/generated
WORKDIR /app/apps/agent-runtime
RUN npx prisma generate --generator client
EXPOSE 3003
# M29 — agent-runtime no longer pushes its schema at startup. Prisma's
# `db push` always drops tables not in the schema, so an agent-runtime push
# would silently delete composer-owned tables (PromptAssembly,
# CapabilityCompiledContext, ...) every time the container restarts.
#
# Schema apply order is now: composer's CMD pushes composer schema (it
# happens to be authoritative for ALL prompt-related tables in the shared
# DB). agent-runtime's schema is applied out-of-band by `bin/bare-metal.sh`
# or `bin/demo-up.sh` BEFORE either container boots (they call
# `prisma db push` against the workspace DB once, with the correct order).
#
# task #113 — `bin/startup.sh` replaces the inline shell to close
# two drift modes that bit this session (DB missing M40's contractHash
# column the client expected; client-vs-schema drift when schema.prisma
# was edited without a rebuild). It applies hand-written .sql
# migrations (idempotent via IF NOT EXISTS) so additive schema changes
# land safely in the shared-DB topology, then regenerates the client.
# RUN_SEED=true tells the wrapper to also run prisma db seed (was
# unconditional before; dev only now).
COPY apps/agent-runtime/bin/startup.sh /usr/local/bin/startup.sh
RUN chmod +x /usr/local/bin/startup.sh
ENV RUN_SEED=true
CMD ["/usr/local/bin/startup.sh", "npm", "run", "dev"]

# ── builder ───────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-runtime ./apps/agent-runtime
WORKDIR /app/apps/agent-runtime
RUN npx prisma generate --generator client && npm run build

# ── runner ────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/agent-runtime
COPY --from=builder /app/apps/agent-runtime/dist ./dist
COPY --from=builder /app/apps/agent-runtime/prisma ./prisma
COPY --from=builder /app/apps/agent-runtime/package.json ./package.json
COPY --from=builder /app/apps/agent-runtime/bin ./bin
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3003
# task #113 — production stage. RUN_SEED unset (default false) so the
# wrapper skips `prisma db seed`. We deliberately drop the prior
# `prisma db push` here too — it was unsafe in the shared-DB topology
# (would drop composer's tables) and we now rely on the hand-written
# additive .sql migrations applied by the wrapper.
RUN chmod +x bin/startup.sh
CMD ["./bin/startup.sh", "node", "dist/server.js"]
