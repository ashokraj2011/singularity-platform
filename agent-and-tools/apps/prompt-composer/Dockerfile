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
RUN cd apps/prompt-composer && npx prisma generate

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
RUN npx prisma generate
EXPOSE 3004
# M29 — composer is now the authoritative writer of its tables (PromptProfile,
# PromptLayer, PromptAssembly, CapabilityCompiledContext, ...). Push the
# schema before starting so the tables exist; agent-runtime no longer owns them.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm run dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/prompt-composer ./apps/prompt-composer
WORKDIR /app/apps/prompt-composer
RUN npx prisma generate && npm run build

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
