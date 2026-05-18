/**
 * M42.1 — Code Foundry runtime config.
 *
 * All values come from env vars. Defaults are tuned for the docker
 * compose stack; production runs supply real bearer tokens and URLs.
 */

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  PORT: Number(process.env.PORT ?? 3005),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  DATABASE_URL: req(
    'DATABASE_URL',
    'postgresql://postgres:singularity@at-postgres:5432/singularity_codegen',
  ),
  // workgraph-api hosts the feature_flags table + admin toggles. The
  // Foundry queries it to gate every entry point.
  WORKGRAPH_API_URL: process.env.WORKGRAPH_API_URL ?? 'http://workgraph-api:8080',
  // Service token used to read /api/internal/feature-flags. Must match
  // workgraph-api's WORKGRAPH_INTERNAL_TOKEN env var. Default is the
  // dev value shipped in workgraph-api/src/config.ts.
  WORKGRAPH_INTERNAL_TOKEN:
    process.env.WORKGRAPH_INTERNAL_TOKEN ?? 'dev-workgraph-internal-token',
  // audit-governance-service (M21). Receipts are POST'd here.
  AUDIT_GOV_URL: process.env.AUDIT_GOV_URL ?? 'http://host.docker.internal:8500',
  AUDIT_GOV_SERVICE_TOKEN:
    process.env.AUDIT_GOV_SERVICE_TOKEN ?? 'dev-audit-gov-service-token',
  // Foundry's own opaque service token (declared but not yet used —
  // arrives in M42.6 when the REST API is hardened with auth).
  CODEGEN_SERVICE_TOKEN: process.env.CODEGEN_SERVICE_TOKEN ?? 'dev-codegen-service-token',
  GENERATOR_VERSION: process.env.GENERATOR_VERSION ?? 'code-foundry-0.2.0',
  TEMPLATE_VERSION: process.env.TEMPLATE_VERSION ?? 'spec-only-0.1.0', // each generator overrides this
  // Per-run output directories live under WORKSPACE_ROOT/<runId>/.
  // Defaults to /workspace which the compose file mounts as a volume.
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT ?? '/workspace',
  // Per-key cache TTL for the feature-flag client (ms).
  FEATURE_FLAG_TTL_MS: Number(process.env.FEATURE_FLAG_TTL_MS ?? 30_000),
}
