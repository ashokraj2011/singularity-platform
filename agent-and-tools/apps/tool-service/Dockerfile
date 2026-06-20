# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml. npm install hoists all workspace deps once; per-app
# stages copy what they need.
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

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
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --workspaces --include-workspace-root --no-audit --no-fund \
 && rm -f .npmrc
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
