# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml — so npm install resolves @agentandtools/shared.
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
RUN npm run build --workspace=packages/shared

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-service ./apps/agent-service
WORKDIR /app/apps/agent-service
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-service ./apps/agent-service
WORKDIR /app/apps/agent-service
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/agent-service
COPY --from=builder /app/apps/agent-service/dist ./dist
COPY --from=builder /app/apps/agent-service/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3001
CMD ["node", "dist/index.js"]
