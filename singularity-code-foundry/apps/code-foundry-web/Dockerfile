# M42.6 — Code Foundry approval UI. Build context is the
# singularity-code-foundry/ workspace root so the SPA can share the
# npm-workspace node_modules tree alongside code-foundry-api.
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/code-foundry-web/package.json ./apps/code-foundry-web/package.json
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY apps/code-foundry-web ./apps/code-foundry-web
WORKDIR /app/apps/code-foundry-web
EXPOSE 5181
# Dev container runs Vite with the src bind-mount from docker-compose
# so the UI hot-reloads end-to-end without rebuilding the image.
CMD ["npm", "run", "dev"]
