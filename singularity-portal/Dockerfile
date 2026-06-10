FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --no-audit --no-fund \
 && rm -f .npmrc

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runner
# MCP + LLM-gateway upstreams are env-overridable so a laptop-split deployment can
# point the /ops-health (+ /api/mcp) proxies at the HOST apps
# (host.docker.internal) when those two services run outside Docker. Defaults are
# the in-compose container names (all-in-Docker). Rendered by nginx envsubst at
# container start; the FILTER keeps envsubst from touching nginx's own $vars.
ENV MCP_UPSTREAM=http://mcp-server:7100 \
    LLM_UPSTREAM=http://llm-gateway:8001 \
    NGINX_ENVSUBST_FILTER="^(MCP_UPSTREAM|LLM_UPSTREAM)$"
RUN mkdir -p /etc/nginx/templates && cat > /etc/nginx/templates/default.conf.template <<'EOF'
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  resolver 127.0.0.11 valid=10s ipv6=off;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;

  location /api/iam/ {
    set $upstream http://iam-service:8100;
    rewrite ^/api/iam/(.*)$ /api/v1/$1 break;
    proxy_pass $upstream;
  }

  location /api/wg/ {
    set $upstream http://workgraph-api:8080;
    rewrite ^/api/wg/(.*)$ /api/$1 break;
    proxy_pass $upstream;
  }

  location /api/composer/ {
    set $upstream http://prompt-composer:3004;
    rewrite ^/api/composer/(.*)$ /api/v1/$1 break;
    proxy_pass $upstream;
  }

  location /api/cf/ {
    set $upstream http://context-api:8000;
    rewrite ^/api/cf/(.*)$ /$1 break;
    proxy_pass $upstream;
  }

  location /api/mcp/ {
    set $upstream ${MCP_UPSTREAM};
    rewrite ^/api/mcp/(.*)$ /$1 break;
    proxy_pass $upstream;
  }

  location /ops-health/iam {
    set $upstream http://iam-service:8100;
    rewrite ^/ops-health/iam$ /api/v1/health break;
    proxy_pass $upstream;
  }

  location /ops-health/workgraph-api {
    set $upstream http://workgraph-api:8080;
    rewrite ^/ops-health/workgraph-api$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/blueprint-workbench {
    set $upstream http://blueprint-workbench:80;
    rewrite ^/ops-health/blueprint-workbench$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/prompt-composer {
    set $upstream http://prompt-composer:3004;
    rewrite ^/ops-health/prompt-composer$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/context-api {
    set $upstream http://context-api:8000;
    rewrite ^/ops-health/context-api$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/llm-gateway {
    set $upstream ${LLM_UPSTREAM};
    rewrite ^/ops-health/llm-gateway$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/context-memory {
    set $upstream http://context-memory:8002;
    rewrite ^/ops-health/context-memory$ /health break;
    proxy_pass $upstream;
  }

  # M65 Slice 1B — metrics-ledger sunsetted; token/cost rollups now live
  # in audit-governance-service. Proxy entry removed (the upstream
  # hostname no longer resolves so nginx returned 502 on every probe).

  location /ops-health/formal-verifier {
    set $upstream http://formal-verifier:8010;
    rewrite ^/ops-health/formal-verifier$ /health break;
    proxy_pass $upstream;
  }

  location /ops-status/formal-verifier {
    set $upstream http://formal-verifier:8010;
    rewrite ^/ops-status/formal-verifier$ /api/v1/verification/status break;
    proxy_pass $upstream;
  }

  location /ops-health/agent-service {
    set $upstream http://agent-service:3001;
    rewrite ^/ops-health/agent-service$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/tool-service {
    set $upstream http://tool-service:3002;
    rewrite ^/ops-health/tool-service$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/agent-runtime {
    set $upstream http://agent-runtime:3003;
    rewrite ^/ops-health/agent-runtime$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/mcp-server {
    set $upstream ${MCP_UPSTREAM};
    rewrite ^/ops-health/mcp-server$ /health break;
    proxy_pass $upstream;
  }

  # Content-hashed build assets — safe to cache forever. A MISSING asset returns
  # a real 404 (not the SPA index.html fallback) so a stale browser fails loudly
  # instead of getting text/html for a module script.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  # index.html / env.js / SPA routes — NEVER cache the HTML or runtime config, so
  # a rebuild (new asset hashes) is picked up on the next load without a manual
  # hard-refresh. This is the permanent fix for "blank page after rebuild".
  location / {
    add_header Cache-Control "no-cache";
    try_files $uri $uri/ /index.html;
  }
}
EOF
COPY --from=build /app/dist /usr/share/nginx/html
# Render the runtime nav-link config at container START from PORTAL_LINK_* env
# (unset → empty → the app falls back to the edge-gateway path defaults). Lets a
# standalone/split deployment re-point the menu without rebuilding the image.
RUN cat > /docker-entrypoint.d/40-portal-env.sh <<'SH' && chmod +x /docker-entrypoint.d/40-portal-env.sh
#!/bin/sh
set -e
cat > /usr/share/nginx/html/env.js <<EOF
window.__ENV__ = {
  LINK_OPERATIONS_PORTAL: "${PORTAL_LINK_OPERATIONS_PORTAL}",
  LINK_AGENT_ADMIN: "${PORTAL_LINK_AGENT_ADMIN}",
  LINK_IAM_ADMIN: "${PORTAL_LINK_IAM_ADMIN}",
  LINK_WORKGRAPH_DESIGNER: "${PORTAL_LINK_WORKGRAPH_DESIGNER}",
  LINK_BLUEPRINT_WORKBENCH: "${PORTAL_LINK_BLUEPRINT_WORKBENCH}",
  LINK_CODE_FOUNDRY: "${PORTAL_LINK_CODE_FOUNDRY}",
};
EOF
SH
EXPOSE 80
