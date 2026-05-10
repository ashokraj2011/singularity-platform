FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm install

FROM base AS builder
ARG AGENT_SERVICE_URL=http://agent-service:3001
ARG TOOL_SERVICE_URL=http://tool-service:3002
ARG AGENT_RUNTIME_URL=http://agent-runtime:3003
ARG PROMPT_COMPOSER_URL=http://prompt-composer:3004
ENV AGENT_SERVICE_URL=$AGENT_SERVICE_URL
ENV TOOL_SERVICE_URL=$TOOL_SERVICE_URL
ENV AGENT_RUNTIME_URL=$AGENT_RUNTIME_URL
ENV PROMPT_COMPOSER_URL=$PROMPT_COMPOSER_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
