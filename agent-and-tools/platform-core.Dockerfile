# syntax=docker/dockerfile:1.7

# Consolidated agent-and-tools backend container.
# It runs agent-service (which serves both /api/v1/agents and /api/v1/tools after
# the Phase 4 merge), agent-runtime, and prompt-composer as separate processes.
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN apk add --no-cache openssl postgresql-client git
RUN mkdir -p /docs/data-model

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY apps/agent-runtime/prisma         ./apps/agent-runtime/prisma
COPY apps/prompt-composer/prisma       ./apps/prompt-composer/prisma
ARG ARTIFACTORY_NPM_REGISTRY=
RUN --mount=type=secret,id=artifactory_npm_token,required=false \
    set -eu; \
    if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then \
      registry_host="$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')"; \
      printf 'registry=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" > .npmrc; \
      if [ -s /run/secrets/artifactory_npm_token ]; then \
        printf '//%s:_authToken=%s\n' "$registry_host" "$(cat /run/secrets/artifactory_npm_token)" >> .npmrc; \
      fi; \
    fi; \
    npm install --workspaces --include-workspace-root --no-audit --no-fund; \
    rm -f .npmrc
RUN npm run build --workspace=packages/shared

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json package-lock.json* ./
COPY apps/agent-service ./apps/agent-service
COPY apps/agent-runtime ./apps/agent-runtime
COPY apps/prompt-composer ./apps/prompt-composer
RUN cd apps/agent-runtime && npx prisma generate --generator client
RUN cd apps/prompt-composer \
 && npx prisma generate --schema=prisma/schema.prisma --generator client \
 && npx prisma generate --schema=prisma/runtime-read.prisma --generator client
RUN npm run build --workspace=apps/agent-service \
 && cd apps/agent-runtime && npx tsc -p tsconfig.json \
 && cd /app/apps/prompt-composer && npx tsc -p tsconfig.json

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json* ./

COPY --from=builder /app/apps/agent-service/dist ./apps/agent-service/dist
COPY --from=builder /app/apps/agent-service/package.json ./apps/agent-service/package.json

COPY --from=builder /app/apps/agent-runtime/dist ./apps/agent-runtime/dist
COPY --from=builder /app/apps/agent-runtime/prisma ./apps/agent-runtime/prisma
COPY --from=builder /app/apps/agent-runtime/generated ./apps/agent-runtime/generated
COPY --from=builder /app/apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY --from=builder /app/apps/agent-runtime/bin ./apps/agent-runtime/bin

COPY --from=builder /app/apps/prompt-composer/dist ./apps/prompt-composer/dist
COPY --from=builder /app/apps/prompt-composer/prisma ./apps/prompt-composer/prisma
COPY --from=builder /app/apps/prompt-composer/generated ./apps/prompt-composer/generated
COPY --from=builder /app/apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY --from=builder /app/apps/prompt-composer/bin ./apps/prompt-composer/bin

COPY bin/start-platform-core.sh ./bin/start-platform-core.sh
RUN chmod +x ./bin/start-platform-core.sh \
 && chmod +x ./apps/agent-runtime/bin/startup.sh \
 && chmod +x ./apps/prompt-composer/bin/startup.sh
EXPOSE 3001 3003 3004
CMD ["./bin/start-platform-core.sh"]
