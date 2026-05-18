import pino from 'pino'

export const log = pino({
  base: { service: 'code-foundry-api' },
  level: process.env.LOG_LEVEL ?? 'info',
})
