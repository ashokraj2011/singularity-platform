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
# M100 P1 — single-origin base path (served under /iam/ by the edge gateway).
# Default '/' keeps the standalone :5175 image unchanged.
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
