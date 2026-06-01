FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/agent-runtime/package.json   ./apps/agent-runtime/package.json
COPY apps/agent-service/package.json   ./apps/agent-service/package.json
COPY apps/tool-service/package.json    ./apps/tool-service/package.json
COPY apps/prompt-composer/package.json ./apps/prompt-composer/package.json
COPY apps/learning-service/package.json ./apps/learning-service/package.json
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --workspaces --include-workspace-root --no-audit --no-fund \
 && rm -f .npmrc
RUN npm run build --workspace=packages/shared || true

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY apps/learning-service ./apps/learning-service
WORKDIR /app/apps/learning-service
EXPOSE 3006
CMD ["npm", "run", "dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY apps/learning-service ./apps/learning-service
WORKDIR /app/apps/learning-service
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/learning-service
COPY --from=builder /app/apps/learning-service/dist ./dist
COPY --from=builder /app/apps/learning-service/package.json ./package.json
COPY --from=builder /app/node_modules ../../node_modules
EXPOSE 3006
CMD ["node", "dist/index.js"]
