FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install \
 && rm -f .npmrc

FROM base AS builder
ARG AGENT_SERVICE_URL=http://agent-service:3001
ARG TOOL_SERVICE_URL=http://tool-service:3002
ARG AGENT_RUNTIME_URL=http://agent-runtime:3003
ARG PROMPT_COMPOSER_URL=http://prompt-composer:3004
ENV AGENT_SERVICE_URL=$AGENT_SERVICE_URL
ENV TOOL_SERVICE_URL=$TOOL_SERVICE_URL
ENV AGENT_RUNTIME_URL=$AGENT_RUNTIME_URL
ENV PROMPT_COMPOSER_URL=$PROMPT_COMPOSER_URL
# M100 P1 — single-origin base path (served under /agent by the edge gateway).
# BASE_PATH sets Next basePath; NEXT_PUBLIC_BASE_PATH is inlined into the client
# bundle so raw fetch() calls hit /agent/api/*. Empty defaults keep root build.
ARG BASE_PATH=
ARG NEXT_PUBLIC_BASE_PATH=
ENV BASE_PATH=$BASE_PATH
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
