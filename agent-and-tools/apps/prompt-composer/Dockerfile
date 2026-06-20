# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml — so npm install resolves @agentandtools/shared.
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN apk add --no-cache openssl
RUN mkdir -p /docs/data-model

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY apps/prompt-composer/prisma       ./apps/prompt-composer/prisma
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --workspaces --include-workspace-root --no-audit --no-fund \
 && rm -f .npmrc
RUN npm run build --workspace=packages/shared
# M30 — generate BOTH Prisma clients (owned + runtime-reader)
RUN cd apps/prompt-composer && npx prisma generate --schema=prisma/schema.prisma --generator client
RUN cd apps/prompt-composer && npx prisma generate --schema=prisma/runtime-read.prisma --generator client

FROM base AS dev
# psql is needed at runtime to apply hand-written .sql migrations
# from bin/startup.sh (Prisma db push would drop agent-runtime's
# tables — we use plain psql + IF NOT EXISTS guards instead).
RUN apk add --no-cache postgresql-client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/prompt-composer ./apps/prompt-composer
# M29 — schema's `output = "../generated/prisma-client"` generates per-service
# client inside the app dir (gitignored so build context doesn't ship it).
# Carry over the generated client from the deps stage AND re-run prisma
# generate in case the schema changed between stages.
COPY --from=deps /app/apps/prompt-composer/generated ./apps/prompt-composer/generated
WORKDIR /app/apps/prompt-composer
# M30 — regenerate BOTH clients in case schemas changed between stages
RUN npx prisma generate --schema=prisma/schema.prisma --generator client
RUN npx prisma generate --schema=prisma/runtime-read.prisma --generator client
EXPOSE 3004
# M29 — DO NOT push schema at startup. Prisma `db push` drops any table not
# in the active schema, and the shared-DB topology means composer's push
# would drop agent-runtime's tables (event_outbox, AgentExecution, etc.) and
# vice-versa.
#
# task #113 — `bin/startup.sh` replaces the bare `npm run dev` to close
# two drift modes that bit this session (DB missing a column that the
# client expects; client missing a column the schema defines). It
# applies hand-written .sql migrations (each guarded with IF NOT EXISTS
# so the shared-DB topology stays safe) and regenerates the client
# before launching. See the script header for details.
COPY apps/prompt-composer/bin/startup.sh /usr/local/bin/startup.sh
RUN chmod +x /usr/local/bin/startup.sh
CMD ["/usr/local/bin/startup.sh", "npm", "run", "dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/prompt-composer ./apps/prompt-composer
WORKDIR /app/apps/prompt-composer
RUN npx prisma generate --schema=prisma/schema.prisma --generator client \
 && npx prisma generate --schema=prisma/runtime-read.prisma --generator client \
 && npm run build

FROM base AS runner
ENV NODE_ENV=production
RUN apk add --no-cache postgresql-client
WORKDIR /app/apps/prompt-composer
COPY --from=builder /app/apps/prompt-composer/dist ./dist
COPY --from=builder /app/apps/prompt-composer/prisma ./prisma
# M29 — runtime stage needs the generated per-service Prisma client too.
COPY --from=builder /app/apps/prompt-composer/generated ./generated
COPY --from=builder /app/apps/prompt-composer/package.json ./package.json
COPY --from=builder /app/apps/prompt-composer/bin ./bin
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3004
# task #113 — same anti-drift wrapper as the dev stage. Prod path
# benefits because the runtime image bundles the pre-built generated
# client; if anyone edits schema.prisma without rebuilding the image
# the startup regenerate keeps the running app honest.
RUN chmod +x bin/startup.sh
CMD ["./bin/startup.sh", "node", "dist/server.js"]
