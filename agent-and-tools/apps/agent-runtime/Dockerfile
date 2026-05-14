# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml. This lets `npm install` resolve workspace deps like
# @agentandtools/shared without per-app inlining.
FROM node:20-alpine AS base
WORKDIR /app
# postgresql-client provides `psql` for the M15 post-push SQL hook.
# git is used by the M17 polling worker to clone + diff repositories.
RUN apk add --no-cache openssl postgresql-client git

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
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
RUN npm run build --workspace=packages/shared
RUN cd apps/agent-runtime && npx prisma generate

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
RUN npx prisma generate
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
# Containers only run post-push.sql + seed at startup.
#
# If you're running `docker compose up` standalone (no bare-metal launcher),
# agent-runtime tables are still created by composer's first push because
# composer reads them (Capability, AgentTemplate, etc.) — composer's schema
# carries the full superset of read-models too.
CMD ["sh", "-c", "psql \"$DATABASE_URL\" -f prisma/post-push.sql && npx prisma db seed && npm run dev"]

# ── builder ───────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-runtime ./apps/agent-runtime
WORKDIR /app/apps/agent-runtime
RUN npx prisma generate && npm run build

# ── runner ────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/agent-runtime
COPY --from=builder /app/apps/agent-runtime/dist ./dist
COPY --from=builder /app/apps/agent-runtime/prisma ./prisma
COPY --from=builder /app/apps/agent-runtime/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3003
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && psql \"$DATABASE_URL\" -f prisma/post-push.sql && node dist/server.js"]
