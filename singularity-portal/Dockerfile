FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runner
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
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
    set $upstream http://mcp-server-demo:7100;
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
    rewrite ^/ops-health/blueprint-workbench$ / break;
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
    set $upstream http://llm-gateway:8001;
    rewrite ^/ops-health/llm-gateway$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/context-memory {
    set $upstream http://context-memory:8002;
    rewrite ^/ops-health/context-memory$ /health break;
    proxy_pass $upstream;
  }

  location /ops-health/metrics-ledger {
    set $upstream http://metrics-ledger:8003;
    rewrite ^/ops-health/metrics-ledger$ /health break;
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
    set $upstream http://mcp-server-demo:7100;
    rewrite ^/ops-health/mcp-server$ /health break;
    proxy_pass $upstream;
  }

  location / { try_files $uri $uri/ /index.html; }
}
EOF
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
