import Ajv from 'ajv'
import { parse as parseYaml } from 'yaml'
import type { RequirementObligation, SpecificationContract } from '../specifications/specification.schemas'

/**
 * Obligation evaluation — the mechanical half of a requirement.
 *
 * A requirement's prose `statement` is only decidable by a judge. Its OBLIGATIONS are typed
 * assertions a machine decides on its own, and their results enter the reconciliation matrix as
 * additional STRUCTURAL evidence, ranking alongside the existing path/evidence checks. Pure — no
 * I/O, no LLM — so every rule here is unit-testable. Anything that needs I/O (reaching a symbol
 * index, reading the submission manifest) is resolved by the service and handed in as facts.
 *
 * THE CENTRAL RULE: unevaluatable is NOT a pass. If the facts needed to decide an obligation are
 * not available — no symbol inventory, a path the inventory does not cover, a contract with no
 * content, a contract kind we have no parser for — the obligation is NOT_VERIFIED. It is never
 * PASS, and it is never FAIL either: FAIL is reserved for an OBSERVED contradiction, where we had
 * the facts and they disagreed with the spec. Silence is not evidence in either direction.
 */

export type ObligationStatus = 'PASS' | 'FAIL' | 'NOT_VERIFIED'

/** Where the facts backing a result came from — recorded so a PASS is auditable. */
export type ObligationProvenance = 'INDEX' | 'MANIFEST' | 'SPEC'

export interface ObligationResult {
  requirementId: string
  obligationId: string
  kind: 'SYMBOL' | 'CONTRACT'
  status: ObligationStatus
  detail: string
  provenance?: ObligationProvenance
}

/** One symbol as reported by a symbol index. Mirrors what the AST index actually stores. */
export interface SymbolFact {
  path: string
  symbol: string
  symbolKind?: string
}

/**
 * A symbol inventory the evaluator may reason over.
 *
 * `coveredPaths` is load-bearing and not optional-in-spirit: an inventory is almost never the whole
 * repository (the live AST index is scoped to a mounted sandbox; a runner-produced manifest usually
 * covers only the files it touched). Absence of a symbol is only evidence of absence for a path the
 * inventory actually covers. For any other path the obligation is NOT_VERIFIED, not FAIL.
 */
export interface SymbolFactSource {
  provenance: 'INDEX' | 'MANIFEST'
  symbols: SymbolFact[]
  coveredPaths: string[]
}

export interface ObligationContext {
  contracts: SpecificationContract[]
  changedFiles: string[]
  /** null when no symbol inventory is available for this submission — the default today. */
  symbolFacts: SymbolFactSource | null
}

export interface ObligationRequirement {
  id: string
  obligations?: RequirementObligation[]
}

/** Compare repository paths without tripping over `./` prefixes, leading slashes, or backslashes. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** FAIL (observed contradiction) outranks NOT_VERIFIED (no facts), which outranks PASS. */
function worst(statuses: ObligationStatus[]): ObligationStatus {
  if (statuses.includes('FAIL')) return 'FAIL'
  if (statuses.includes('NOT_VERIFIED')) return 'NOT_VERIFIED'
  return 'PASS'
}

// ── Symbol obligations ─────────────────────────────────────────────────────
//
// Asserts: a symbol named N (optionally of kind K) exists at path P.
//
// NOT asserted: exported-ness. The AST index stores no export flag — it is recoverable only by
// regexing the stored signature text, which misses `export { x }` re-export lists and means nothing
// for Go (capitalisation) or Java (modifiers). The obligation is deliberately scoped to what the
// index can actually answer: name, kind, and path.

function evaluateSymbol(
  requirementId: string,
  o: Extract<RequirementObligation, { kind: 'SYMBOL' }>,
  ctx: ObligationContext,
): ObligationResult {
  const base = { requirementId, obligationId: o.id, kind: 'SYMBOL' as const }
  const want = normalizePath(o.path)

  if (!ctx.symbolFacts) {
    return { ...base, status: 'NOT_VERIFIED', detail: `No symbol inventory is available for this submission; cannot check that \`${o.symbol}\` exists at ${o.path}.` }
  }

  const src = ctx.symbolFacts
  const covered = src.coveredPaths.some((p) => normalizePath(p) === want)
  if (!covered) {
    return { ...base, status: 'NOT_VERIFIED', provenance: src.provenance, detail: `The symbol inventory does not cover ${o.path}; absence of \`${o.symbol}\` there is not evidence.` }
  }

  const hit = src.symbols.find((s) => normalizePath(s.path) === want && s.symbol === o.symbol)
  if (!hit) {
    return { ...base, status: 'FAIL', provenance: src.provenance, detail: `${o.path} is indexed but declares no symbol named \`${o.symbol}\`.` }
  }
  if (o.symbolKind && hit.symbolKind && hit.symbolKind !== o.symbolKind) {
    return { ...base, status: 'FAIL', provenance: src.provenance, detail: `\`${o.symbol}\` exists at ${o.path} but is a ${hit.symbolKind}, not a ${o.symbolKind}.` }
  }
  if (o.symbolKind && !hit.symbolKind) {
    return { ...base, status: 'NOT_VERIFIED', provenance: src.provenance, detail: `\`${o.symbol}\` exists at ${o.path} but the inventory records no kind, so "${o.symbolKind}" cannot be confirmed.` }
  }
  return { ...base, status: 'PASS', provenance: src.provenance, detail: `\`${o.symbol}\`${o.symbolKind ? ` (${o.symbolKind})` : ''} found at ${o.path}.` }
}

// ── Contract obligations ───────────────────────────────────────────────────
//
// WHERE THE LINE IS DRAWN. The reconciliation pipeline has no repository-content fetch — it sees the
// spec package, the declared claims/evidence, and a list of changed file PATHS. So this check does
// two things it can genuinely do, and does not pretend to do the third:
//
//   1. SPEC SIDE (decidable): the declared contract resolves, its content parses, and the
//      operations/fields the obligation names are actually declared by it. This is what closes the
//      declared-and-never-checked gap on `contracts[]`.
//   2. DELIVERY SIDE (decidable): the contract's artifact path appears in the submission's change
//      manifest — i.e. this diff actually touched the artifact the requirement is about.
//
//   3. NOT DONE: semantic equivalence between the declared contract and the committed artifact's
//      bytes. That needs the artifact's contents, which this layer cannot read. A PASS here means
//      "the contract is well-formed, complete for what was asserted, and its artifact was
//      delivered" — not "the shipped API matches the schema".

const PARSEABLE_CONTRACT_KINDS = new Set(['OPENAPI', 'ASYNCAPI', 'JSON_SCHEMA'])

/** Parse contract content as JSON, falling back to YAML (OpenAPI is commonly authored as YAML). */
function parseContractContent(content: string): Record<string, unknown> | null {
  const attempt = (fn: () => unknown): Record<string, unknown> | null => {
    try {
      const v = fn()
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return attempt(() => JSON.parse(content)) ?? attempt(() => parseYaml(content))
}

/** True when the document is a structurally valid JSON Schema (meta-schema check, no $ref resolution). */
function isValidJsonSchema(doc: Record<string, unknown>): boolean {
  try {
    const ajv = new Ajv({ strict: false, validateSchema: true, allErrors: false })
    return ajv.validateSchema(doc) === true
  } catch {
    return false
  }
}

/** `METHOD /path` → declared by an OpenAPI document's `paths` map. */
function missingOperations(doc: Record<string, unknown>, operations: string[]): string[] {
  const paths = doc.paths
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return [...operations]
  const table = paths as Record<string, unknown>
  return operations.filter((op) => {
    const parts = op.trim().split(/\s+/)
    if (parts.length < 2) return true
    const method = parts[0].toLowerCase()
    const route = parts.slice(1).join(' ')
    const entry = table[route]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    return !(method in (entry as Record<string, unknown>))
  })
}

/** Top-level property names declared by a JSON Schema document. */
function missingFields(doc: Record<string, unknown>, fields: string[]): string[] {
  const props = doc.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [...fields]
  const table = props as Record<string, unknown>
  return fields.filter((f) => !(f in table))
}

function evaluateContract(
  requirementId: string,
  o: Extract<RequirementObligation, { kind: 'CONTRACT' }>,
  ctx: ObligationContext,
): ObligationResult {
  const base = { requirementId, obligationId: o.id, kind: 'CONTRACT' as const }
  const statuses: ObligationStatus[] = []
  const notes: string[] = []

  const contract = ctx.contracts.find((c) => c.id === o.contractId)
  if (!contract) {
    return { ...base, status: 'NOT_VERIFIED', detail: `Obligation references contract \`${o.contractId}\`, which the specification package does not declare.` }
  }

  const wantsContentCheck = Boolean(o.operations?.length || o.fields?.length)
  if (wantsContentCheck) {
    const content = typeof contract.content === 'string' ? contract.content.trim() : ''
    if (!content) {
      statuses.push('NOT_VERIFIED')
      notes.push(`contract \`${contract.id}\` declares no content to check`)
    } else if (!PARSEABLE_CONTRACT_KINDS.has(String(contract.kind))) {
      statuses.push('NOT_VERIFIED')
      notes.push(`no parser for contract kind ${contract.kind}`)
    } else {
      const doc = parseContractContent(content)
      if (!doc) {
        statuses.push('NOT_VERIFIED')
        notes.push(`contract \`${contract.id}\` content does not parse as JSON or YAML`)
      } else if (contract.kind === 'JSON_SCHEMA' && !isValidJsonSchema(doc)) {
        statuses.push('NOT_VERIFIED')
        notes.push(`contract \`${contract.id}\` is not a structurally valid JSON Schema`)
      } else {
        if (o.operations?.length) {
          const missing = missingOperations(doc, o.operations)
          if (missing.length) {
            statuses.push('FAIL')
            notes.push(`contract \`${contract.id}\` does not declare operation(s): ${missing.join(', ')}`)
          } else {
            statuses.push('PASS')
            notes.push(`all ${o.operations.length} declared operation(s) present`)
          }
        }
        if (o.fields?.length) {
          const missing = missingFields(doc, o.fields)
          if (missing.length) {
            statuses.push('FAIL')
            notes.push(`contract \`${contract.id}\` does not declare field(s): ${missing.join(', ')}`)
          } else {
            statuses.push('PASS')
            notes.push(`all ${o.fields.length} declared field(s) present`)
          }
        }
      }
    }
  }

  if (o.path) {
    const want = normalizePath(o.path)
    if (ctx.changedFiles.length === 0) {
      statuses.push('NOT_VERIFIED')
      notes.push(`no change manifest available to confirm ${o.path} was delivered`)
    } else if (!ctx.changedFiles.some((f) => normalizePath(f) === want)) {
      statuses.push('FAIL')
      notes.push(`contract artifact ${o.path} is not in the submission's change manifest`)
    } else {
      statuses.push('PASS')
      notes.push(`contract artifact ${o.path} was delivered`)
    }
  }

  // An obligation that asserts nothing beyond "this contract exists" is satisfied by resolving it.
  if (statuses.length === 0) {
    return { ...base, status: 'PASS', provenance: 'SPEC', detail: `Contract \`${contract.id}\` is declared by the specification.` }
  }
  return { ...base, status: worst(statuses), provenance: 'SPEC', detail: `${notes.join('; ')}.` }
}

/**
 * Evaluate every obligation on every supplied requirement. Requirements with no obligations
 * contribute nothing, so a specification that uses none produces an empty result set and leaves the
 * verdict matrix exactly as it was before obligations existed.
 */
export function evaluateObligations(requirements: ObligationRequirement[], ctx: ObligationContext): ObligationResult[] {
  const results: ObligationResult[] = []
  for (const req of requirements) {
    for (const o of req.obligations ?? []) {
      results.push(o.kind === 'SYMBOL' ? evaluateSymbol(req.id, o, ctx) : evaluateContract(req.id, o, ctx))
    }
  }
  return results
}
