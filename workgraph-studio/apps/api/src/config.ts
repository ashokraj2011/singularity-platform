import { config as dotenvConfig } from 'dotenv'
import { z } from 'zod'

dotenvConfig()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.coerce.boolean().default(false),
  MINIO_ACCESS_KEY: z.string().default('workgraph'),
  MINIO_SECRET_KEY: z.string().default('workgraph_secret'),
  MINIO_BUCKET: z.string().default('workgraph-documents'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),

  // ── Identity provider (Singularity IAM federation) ─────────────────────────
  // 'iam'   → all auth + authz delegated to IAM (production)
  // 'local' → fall back to the built-in HS256 JWT + bcrypt login (offline dev)
  AUTH_PROVIDER: z.enum(['iam', 'local']).default('local'),
  // Base URL for the IAM HTTP API (e.g. http://localhost:8100/api/v1).
  IAM_BASE_URL: z.string().optional(),
  // Long-lived bearer used by workgraph-studio when calling IAM as a service
  // (e.g. for member lookups, skill resolution).  Required if AUTH_PROVIDER=iam.
  IAM_SERVICE_TOKEN: z.string().optional(),
  // TTL (seconds) for the in-memory token-verification cache.
  IAM_VERIFY_CACHE_TTL: z.coerce.number().default(60),

  // ── Prompt Composer (M5 — kept for backwards compat; M8 routes through context-fabric) ──
  PROMPT_COMPOSER_URL: z.string().default('http://localhost:3004'),

  // ── Context Fabric (M8 — AGENT_TASK executor calls /execute) ──
  CONTEXT_FABRIC_URL: z.string().default('http://localhost:8000'),
  // M13 — service token for context-fabric's /internal/mcp/* surface (the
  // proxy that resolves code-changes through MCP). Should match the value
  // configured on context-fabric as IAM_SERVICE_TOKEN. In dev with no IAM
  // (pseudo-iam mode) this can be any matching string.
  CONTEXT_FABRIC_SERVICE_TOKEN: z.string().optional(),

  // ── M10 — agent-and-tools upstream URLs for federated lookups ──
  AGENT_SERVICE_URL: z.string().default('http://localhost:3001'),
  TOOL_SERVICE_URL:  z.string().default('http://localhost:3002'),
  AGENT_RUNTIME_URL: z.string().default('http://localhost:3003'),
  // Snapshot-time token used by the workflow runtime when no user context is
  // available (AgentTaskExecutor writing the agent snapshot row). User-facing
  // /api/lookup/* calls forward the caller's JWT instead.
  WORKGRAPH_SNAPSHOT_TOKEN: z.string().optional(),

  // M24 — audit-governance ledger (port 8500). Used by the run insights
  // dashboard to splice cost/token/governance rollups into the per-run view.
  AUDIT_GOV_URL: z.string().default('http://host.docker.internal:8500'),

  // MCP owns local execution; the central LLM gateway owns provider/model
  // routing. Workflow execution passes model aliases through Context Fabric.
  MCP_SERVER_URL: z.string().default('http://localhost:7100'),
  MCP_BEARER_TOKEN: z.string().default('demo-bearer-token-must-be-min-16-chars'),
  WORKGRAPH_INTERNAL_TOKEN: z.string().default('dev-workgraph-internal-token'),
  EVENT_HORIZON_MODEL_ALIAS: z.string().optional(),

  // ── M33 — Central LLM Gateway ───────────────────────────────────────────
  // Direct one-shot LLM calls (legacy /:id/runs endpoint) go through the
  // central gateway. There is no provider fallback chain; gateway errors
  // propagate. LLM_GATEWAY_URL=mock enables an in-process mock for tests.
  LLM_GATEWAY_URL: z.string().default('http://llm-gateway:8001'),
  LLM_GATEWAY_BEARER: z.string().optional(),
  LLM_GATEWAY_TIMEOUT_SEC: z.coerce.number().int().positive().default(240),
})

// M35.1 — production-class envs refuse to start with weak secrets.
// Mirrors the @agentandtools/shared assertProductionSecret helper.
// Inlined here because workgraph-api lives outside the agent-and-tools
// workspace and can't import that package.
function assertProductionSecretLocal(name: string, value: string | undefined, minLength = 32): void {
  const env = (process.env.NODE_ENV ?? 'development').toLowerCase()
  if (!['production', 'prod', 'staging', 'perf'].includes(env)) return
  const KNOWN_BAD = new Set([
    'dev-secret-change-in-prod',
    'dev-secret-change-in-prod-min-32-chars!!',
    'changeme_dev_only_min_32_chars_long!!',
    'demo-bearer-token-must-be-min-16-chars',
    'dev-audit-gov-service-token',
    'changeme',
    'test-secret',
  ])
  const v = value ?? ''
  const reasons: string[] = []
  if (v.length === 0) reasons.push('unset')
  else if (v.length < minLength) reasons.push(`shorter than ${minLength} chars (got ${v.length})`)
  if (KNOWN_BAD.has(v)) reasons.push('matches a known development default')
  if (reasons.length > 0) {
    console.error(`FATAL: ${name} is unsafe for NODE_ENV=${env}: ${reasons.join('; ')}. Set ${name} to a strong random value (${minLength}+ chars) and restart.`)
    process.exit(1)
  }
}

function loadConfig() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors)
    process.exit(1)
  }
  assertProductionSecretLocal('JWT_SECRET', result.data.JWT_SECRET)
  return result.data
}

export const config = loadConfig()
