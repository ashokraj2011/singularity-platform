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
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n\n  add_header Cache-Control "no-store, no-cache, must-revalidate" always;\n  add_header Pragma "no-cache" always;\n  add_header Expires "0" always;\n\n  location /api/ {\n    proxy_pass http://workgraph-api:8080/api/;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_read_timeout 300s;\n  }\n\n  location /assets/ { try_files $uri =404; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/blueprint-workbench/dist /usr/share/nginx/html
EXPOSE 80
