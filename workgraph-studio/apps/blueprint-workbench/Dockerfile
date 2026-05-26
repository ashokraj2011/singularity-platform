# Build context must be the workgraph-studio repo root.

FROM node:22-alpine AS base
RUN npm install -g pnpm@10

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/blueprint-workbench/package.json apps/blueprint-workbench/package.json
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/blueprint-workbench ./apps/blueprint-workbench
RUN pnpm --filter blueprint-workbench build

FROM nginx:1.27-alpine AS runner
# M69 Loop Theater — Phase 1 needs /audit-gov/* to reach the
# audit-governance-service container so the theater can fetch the event
# history for a trace. SSE for live tail (Phase 2) needs proxy_buffering
# off + the same long read timeout as /api/. Kept on the same nginx
# instance so the browser only sees the workbench origin.
#
# 2026-05-26: proxy_read_timeout bumped 300s → 600s. Verification-running
# stages (qa-review, test-certification) issue 1-4 long `mvn`/`pytest`
# tool calls in VERIFY, each 30-75s. Repro: test-certification attempt
# 0b5d181e took 303s end-to-end and tipped past the 300s cap by 3s.
# nginx returned 504 even though the agent finished 1.1s later in
# context-fabric — the work was real, the client just gave up. The
# workgraph-api itself sets timeoutSec=480 (+10s buffer) on its CF call,
# so nginx must give it at least that much slack. 600s leaves ~100s of
# headroom above the worst observed case.
#
# 2026-05-26 (later): nginx retry directives buy us little for the
# docker-restart-window case. ECONNREFUSED returns instantly, and
# nginx has no native retry-after-delay; proxy_next_upstream_tries=N
# just fires N attempts in milliseconds. We keep a modest 2-try
# config so genuinely-flaky upstream connections (network blips,
# slow SYNs) get a second chance, but the real mitigation for
# deploy-window 502s lives in the workbench client (see api.ts —
# request() retries 502/503/504 once after 1.5s). Reads only —
# the client retry is disabled for POST/PUT/PATCH/DELETE so an
# accidental double-mutation can't happen.
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n\n  resolver 127.0.0.11 ipv6=off valid=10s;\n  set $workgraph_api http://workgraph-api:8080;\n  set $audit_gov http://host.docker.internal:8500;\n\n  add_header Cache-Control "no-store, no-cache, must-revalidate" always;\n  add_header Pragma "no-cache" always;\n  add_header Expires "0" always;\n\n  location = /health {\n    default_type application/json;\n    return 200 "{\"status\":\"ok\",\"service\":\"blueprint-workbench\",\"mode\":\"nginx\"}";\n  }\n\n  location /api/ {\n    proxy_pass $workgraph_api;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_read_timeout 600s;\n    proxy_connect_timeout 5s;\n    proxy_next_upstream error timeout http_502 http_503 http_504;\n    proxy_next_upstream_tries 2;\n  }\n\n  location /audit-gov/ {\n    rewrite ^/audit-gov/(.*)$ /$1 break;\n    proxy_pass $audit_gov;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_buffering off;\n    proxy_read_timeout 3600s;\n  }\n\n  location /assets/ { try_files $uri =404; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/blueprint-workbench/dist /usr/share/nginx/html
EXPOSE 80
