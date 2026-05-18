/**
 * M42.1 — Shared feature-flag client wired with this service's runtime
 * config. Used by both the REST middleware and the CLI gate so they
 * apply identical resolution rules and identical FEATURE_DISABLED
 * payloads.
 */
import { FeatureFlagsClient } from '@singularity-code-foundry/feature-flags'
import { config } from '../config.js'

let _client: FeatureFlagsClient | null = null

export function getFlagsClient(): FeatureFlagsClient {
  if (_client) return _client
  _client = new FeatureFlagsClient({
    baseUrl: config.WORKGRAPH_API_URL,
    serviceToken: config.WORKGRAPH_INTERNAL_TOKEN,
    cacheTtlMs: config.FEATURE_FLAG_TTL_MS,
  })
  return _client
}

// Re-export so callers can import the error type without dragging the
// shared package into every module's import surface.
export { FeatureDisabledError } from '@singularity-code-foundry/feature-flags'
