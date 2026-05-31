FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

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
