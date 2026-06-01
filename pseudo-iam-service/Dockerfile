FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
# Artifactory support (docs/artifactory-npm.md): no-op unless build args set.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' "$ARTIFACTORY_NPM_REGISTRY" "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" "$ARTIFACTORY_NPM_TOKEN" > .npmrc; fi \
 && npm install --omit=dev=false \
 && rm -f .npmrc

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 8101
CMD ["node", "dist/index.js"]
