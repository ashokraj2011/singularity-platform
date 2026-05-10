FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3004
# Note: do NOT run `prisma db push` here. agent-runtime owns schema until M3.
# Composer reads/writes existing tables via the shared Postgres.
CMD ["sh", "-c", "npm run dev"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3004
# Note: do NOT run `prisma db push` here. agent-runtime owns schema until M3.
CMD ["node", "dist/server.js"]
