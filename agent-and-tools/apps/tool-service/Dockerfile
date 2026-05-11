# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml. npm install hoists all workspace deps once; per-app
# stages copy what they need.
FROM node:20-alpine AS base
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────
# Copy ALL workspace package.json files so npm can resolve transitive deps
# correctly across the monorepo. Heavy on the COPY layer but cached well.
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
RUN npm run build --workspace=packages/shared

# ── dev ───────────────────────────────────────────────────────────────────
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/tool-service ./apps/tool-service
WORKDIR /app/apps/tool-service
EXPOSE 3002
CMD ["npm", "run", "dev"]

# ── builder ───────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/tool-service ./apps/tool-service
WORKDIR /app/apps/tool-service
RUN npm run build

# ── runner ────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/tool-service
COPY --from=builder /app/apps/tool-service/dist ./dist
COPY --from=builder /app/apps/tool-service/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
COPY --from=builder /app/packages ../../packages
EXPOSE 3002
CMD ["node", "dist/index.js"]
