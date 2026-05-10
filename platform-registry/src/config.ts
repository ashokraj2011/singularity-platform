import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV:      z.enum(['development', 'production', 'test']).default('development'),
  PORT:          z.coerce.number().default(8090),
  DATABASE_URL:  z.string().default('postgresql://platform:platform_secret@localhost:5435/platform_registry'),
  // Comma-separated list of trusted service-account tokens that may POST /register.
  // Empty = no auth (dev only).
  REGISTER_TOKENS: z.string().default(''),
})

export const config = envSchema.parse(process.env)

export const allowedRegisterTokens: Set<string> = new Set(
  config.REGISTER_TOKENS.split(',').map((s) => s.trim()).filter(Boolean),
)
