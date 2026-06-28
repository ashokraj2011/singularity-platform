# Build context is the monorepo root (agent-and-tools/) — set in
# docker-compose.yml — so npm install resolves @agentandtools/shared.
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

FROM base AS deps
# Artifactory support (docs/artifactory-npm.md). Set → resolve from Artifactory
# via a throwaway .npmrc (removed after install); empty → no-op (default registry).
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then \
      printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' \
        "$ARTIFACTORY_NPM_REGISTRY" \
        "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" \
        "$ARTIFACTORY_NPM_TOKEN" > .npmrc ; \
    fi \
 && npm install --workspaces --include-workspace-root --no-audit --no-fund \
 && rm -f .npmrc
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
