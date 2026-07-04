FROM node:20-alpine AS base
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

FROM base AS next-deps
WORKDIR /app/agent-and-tools/web
COPY agent-and-tools/web/package.json ./
ARG ARTIFACTORY_NPM_REGISTRY=
RUN --mount=type=secret,id=artifactory_npm_token,required=false \
    if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then \
      registry_host="$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')"; \
      printf 'registry=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" > .npmrc; \
      token="$(cat /run/secrets/artifactory_npm_token 2>/dev/null || true)"; \
      if [ -n "$token" ]; then printf '//%s:_authToken=%s\n' "$registry_host" "$token" >> .npmrc; fi; \
    fi \
 && npm install --include=dev --package-lock=false \
 && rm -f .npmrc

FROM base AS workbench-deps
WORKDIR /app/workgraph-studio/apps/blueprint-workbench
COPY workgraph-studio/apps/blueprint-workbench/package.json ./
COPY workgraph-studio/apps/blueprint-workbench/package-lock.json ./
ARG ARTIFACTORY_NPM_REGISTRY=
RUN --mount=type=secret,id=artifactory_npm_token,required=false \
    if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then \
      registry_host="$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')"; \
      printf 'registry=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" > .npmrc; \
      token="$(cat /run/secrets/artifactory_npm_token 2>/dev/null || true)"; \
      if [ -n "$token" ]; then printf '//%s:_authToken=%s\n' "$registry_host" "$token" >> .npmrc; fi; \
    fi \
 && npm install --include=dev --package-lock=false \
 && rm -f .npmrc

FROM base AS workbench-builder
WORKDIR /app/workgraph-studio/apps/blueprint-workbench
ENV BASE_PATH=/workbench/
COPY --from=workbench-deps /app/workgraph-studio/apps/blueprint-workbench/node_modules ./node_modules
COPY workgraph-studio/apps/blueprint-workbench/package.json ./
COPY workgraph-studio/apps/blueprint-workbench/package-lock.json ./
COPY workgraph-studio/apps/blueprint-workbench/index.html ./
COPY workgraph-studio/apps/blueprint-workbench/tsconfig.json ./
COPY workgraph-studio/apps/blueprint-workbench/vite.config.ts ./
COPY workgraph-studio/apps/blueprint-workbench/src ./src
RUN npm run build

FROM base AS next-builder
WORKDIR /app/agent-and-tools/web
ARG AGENT_SERVICE_URL=http://agent-service:3001
ARG TOOL_SERVICE_URL=http://agent-service:3001
ARG AGENT_RUNTIME_URL=http://agent-runtime:3003
ARG PROMPT_COMPOSER_URL=http://prompt-composer:3004
ENV AGENT_SERVICE_URL=$AGENT_SERVICE_URL
ENV TOOL_SERVICE_URL=$TOOL_SERVICE_URL
ENV AGENT_RUNTIME_URL=$AGENT_RUNTIME_URL
ENV PROMPT_COMPOSER_URL=$PROMPT_COMPOSER_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=next-deps /app/agent-and-tools/web/node_modules ./node_modules
COPY agent-and-tools/web ./
COPY workgraph-studio/apps/web/src /app/workgraph-studio/apps/web/src
COPY workgraph-studio/packages/engine/src /app/workgraph-studio/packages/engine/src
COPY workgraph-studio/apps/blueprint-workbench/src /app/workgraph-studio/apps/blueprint-workbench/src
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache nginx
COPY --from=next-builder /app/agent-and-tools/web/.next/standalone ./
COPY --from=next-builder /app/agent-and-tools/web/.next/static ./.next/static
COPY --from=next-builder /app/agent-and-tools/web/.next/static ./web/.next/static
COPY --from=next-builder /app/agent-and-tools/web/public ./public
COPY --from=next-builder /app/agent-and-tools/web/public ./web/public
COPY --from=workbench-builder /app/workgraph-studio/apps/blueprint-workbench/dist ./workbench
COPY agent-and-tools/web/platform.nginx.conf /etc/nginx/http.d/default.conf
COPY agent-and-tools/web/scripts/check-standalone-bundle.mjs /app/check-standalone-bundle.mjs
RUN mkdir -p /run/nginx && cat > /app/start-platform-web.sh <<'SH' && chmod +x /app/start-platform-web.sh
#!/bin/sh
set -e
platform_env="$(printf '%s,%s,%s' "${APP_ENV:-}" "${ENVIRONMENT:-}" "${SINGULARITY_ENV:-}" | tr '[:upper:]' '[:lower:]')"
case "$platform_env" in
  *development*|*dev*|*local*|*test*)
    production_class=0
    ;;
  *production*|*prod*|*staging*|*perf*)
    production_class=1
    ;;
  *)
    case "$(printf '%s' "${NODE_ENV:-}" | tr '[:upper:]' '[:lower:]')" in
      production|prod|staging|perf) production_class=1 ;;
      *) production_class=0 ;;
    esac
    ;;
esac
if [ "$production_class" = "1" ]; then
    for pair in \
      "AUDIT_GOV_SERVICE_TOKEN:${AUDIT_GOV_SERVICE_TOKEN:-}" \
      "WORKGRAPH_PROXY_SERVICE_TOKEN:${WORKGRAPH_PROXY_SERVICE_TOKEN:-}"
    do
      name="${pair%%:*}"
      value="${pair#*:}"
      case "$value" in
        ""|dev-*|test-*|change-me*|changeme*|Admin1234!)
          echo "FATAL: $name must be a strong non-default service token in production-class platform-web." >&2
          exit 1
          ;;
      esac
      if [ "${#value}" -lt 32 ]; then
        echo "FATAL: $name must be at least 32 characters in production-class platform-web." >&2
        exit 1
      fi
    done
fi
SERVER_ROOT="$(node /app/check-standalone-bundle.mjs /app --print-root)"
cd "$SERVER_ROOT"
HOSTNAME=0.0.0.0 PORT=3000 node server.js &
exec nginx -g 'daemon off;'
SH
EXPOSE 80
CMD ["/app/start-platform-web.sh"]
