# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml — so npm install resolves @agentandtools/shared.
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY apps/prompt-composer/prisma       ./apps/prompt-composer/prisma
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
RUN npm run build --workspace=packages/shared
# M30 — generate BOTH Prisma clients (owned + runtime-reader)
RUN cd apps/prompt-composer && npx prisma generate --schema=prisma/schema.prisma
RUN cd apps/prompt-composer && npx prisma generate --schema=prisma/runtime-read.prisma

FROM base AS dev
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
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npx prisma generate --schema=prisma/runtime-read.prisma
EXPOSE 3004
# M29 — DO NOT push schema at startup. Prisma `db push` drops any table not
# in the active schema, and the shared-DB topology means composer's push
# would drop agent-runtime's tables (event_outbox, AgentExecution, etc.) and
# vice-versa. Operators apply both schemas in order via:
#   bin/bare-metal.sh up   (for bare-metal dev)
#   bin/apply-schemas.sh   (for the docker stack, one-shot per-volume)
# On every subsequent container restart, the DB shape is already correct and
# no pushes are needed.
CMD ["sh", "-c", "npm run dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/prompt-composer ./apps/prompt-composer
WORKDIR /app/apps/prompt-composer
RUN npx prisma generate --schema=prisma/schema.prisma \
 && npx prisma generate --schema=prisma/runtime-read.prisma \
 && npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/prompt-composer
COPY --from=builder /app/apps/prompt-composer/dist ./dist
COPY --from=builder /app/apps/prompt-composer/prisma ./prisma
# M29 — runtime stage needs the generated per-service Prisma client too.
COPY --from=builder /app/apps/prompt-composer/generated ./generated
COPY --from=builder /app/apps/prompt-composer/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3004
CMD ["node", "dist/server.js"]
