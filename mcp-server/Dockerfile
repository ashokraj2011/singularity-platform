FROM node:20-alpine AS base
WORKDIR /app
# M16 — git is required by the git_commit tool. Empty /workspace dir is the
# default sandbox root. Mount a host volume in compose to expose real files.
RUN apk add --no-cache git && mkdir -p /workspace

FROM base AS deps
COPY package.json ./
RUN npm install --no-audit --no-fund

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
