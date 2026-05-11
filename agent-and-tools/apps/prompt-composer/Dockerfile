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
WORKDIR /app/apps/prompt-composer
EXPOSE 3004
# Composer reads/writes existing tables via the shared Postgres; agent-runtime
# owns the schema (no `prisma db push` here).
CMD ["sh", "-c", "npm run dev"]

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
COPY --from=builder /app/apps/prompt-composer/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3004
CMD ["node", "dist/server.js"]
