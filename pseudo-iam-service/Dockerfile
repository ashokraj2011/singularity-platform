FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev=false

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
