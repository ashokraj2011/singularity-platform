# Build context is the singularity-code-foundry/ root (set in compose) so
# the @singularity-code-foundry/feature-flags workspace dependency resolves.
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/code-foundry-api/package.json ./apps/code-foundry-api/package.json
COPY apps/code-foundry-api/prisma ./apps/code-foundry-api/prisma
RUN npm install --workspaces --include-workspace-root --no-audit --no-fund
RUN cd apps/code-foundry-api && npx prisma generate

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json tsconfig.json ./
COPY apps/code-foundry-api ./apps/code-foundry-api
WORKDIR /app/apps/code-foundry-api
RUN npx prisma generate
# Workspace volume mount target — must exist before the bind mount lands.
RUN mkdir -p /workspace
EXPOSE 3005
# Dev container hot-reloads via tsx watch + the src bind-mount from
# docker-compose. Prisma client is regenerated above; the schema itself
# is applied via prisma db push on first boot (see entrypoint.sh below).
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss=false && npm run dev"]
