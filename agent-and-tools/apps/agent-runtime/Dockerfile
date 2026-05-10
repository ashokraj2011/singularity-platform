FROM node:20-alpine AS base
WORKDIR /app
# postgresql-client provides `psql` for the M15 post-push SQL hook.
RUN apk add --no-cache openssl postgresql-client

FROM base AS deps
COPY package.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3003
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && psql \"$DATABASE_URL\" -f prisma/post-push.sql && npx prisma db seed && npm run dev"]

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
EXPOSE 3003
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && psql \"$DATABASE_URL\" -f prisma/post-push.sql && node dist/server.js"]
