FROM node:20-alpine AS base
WORKDIR /app
# M16 — git is required by git_commit. Empty /workspace dir is the default
# sandbox root; mount a host volume in compose to expose real files.
# M18 — ripgrep powers the search_code tool.
RUN apk add --no-cache git ripgrep && mkdir -p /workspace

FROM base AS deps
# Artifactory support (docs/artifactory-npm.md). When these build args are set,
# write a throwaway .npmrc for this layer so npm resolves from the office
# Artifactory; empty → no-op (default registry). .npmrc is removed after
# install and only node_modules is copied forward, so the token never reaches
# the final image.
ARG ARTIFACTORY_NPM_REGISTRY=
ARG ARTIFACTORY_NPM_TOKEN=
COPY package.json ./
RUN if [ -n "$ARTIFACTORY_NPM_REGISTRY" ]; then \
      printf 'registry=%s\n//%s:_authToken=%s\naudit=false\nfund=false\n' \
        "$ARTIFACTORY_NPM_REGISTRY" \
        "$(printf '%s' "$ARTIFACTORY_NPM_REGISTRY" | sed -E 's#^https?://##')" \
        "$ARTIFACTORY_NPM_TOKEN" > .npmrc ; \
    fi \
 && npm install --no-audit --no-fund \
 && rm -f .npmrc

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 7000
CMD ["npm", "run", "dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 7000
CMD ["node", "dist/index.js"]

FROM base AS sandbox-runner
RUN apk add --no-cache docker-cli
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 7110
CMD ["node", "dist/runner/server.js"]
