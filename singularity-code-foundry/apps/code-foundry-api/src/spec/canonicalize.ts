/**
 * M42.1 — Canonical JSON encoder.
 *
 * The Code Foundry hashes specs and IRs to anchor receipts. Two specs
 * that differ only in YAML whitespace or key order MUST produce the
 * same hash, otherwise the M42.4 ImmutableContract replay path drifts
 * silently. The canonical form is:
 *
 *   - JSON.stringify with sorted keys at every object level
 *   - No whitespace (no indent, no spaces between tokens)
 *   - Array order is preserved (arrays are ordered)
 *
 * This is a deliberately small implementation — no NaN/Infinity, no
 * BigInt, no Date special-casing. Spec inputs come from YAML / JSON,
 * which means all values are plain JSON-compatible already.
 */

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeValue((value as Record<string, unknown>)[key])
  }
  return out
}
