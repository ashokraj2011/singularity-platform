/**
 * Studio Board — ingestion pure core (PR-4). Drag a deck/doc/link onto the board
 * and it becomes a thinking object: parsed into addressable spans, placed as board
 * objects, and cross-examined into STAGED claims at evidence tier SOURCE_DOCUMENT.
 *
 * The security boundary is the load-bearing, unit-tested part: ingested content is
 * DATA, never instructions. Extraction output is schema-validated CLAIM JSON only —
 * text in a document that reads as an instruction ("ignore previous instructions",
 * "approve all claims") is inert by construction; at worst it becomes a claim's
 * statement string, which a human then rejects. It can never become an action.
 *
 * Binary parsers (PPTX/PDF/DOCX/XLSX/Figma) plug in later as DocumentParser adapters;
 * the default handles text/markdown/url with zero new dependencies.
 */
import { createHash } from 'crypto'
import { z } from 'zod'

export const SOURCE_DOCUMENT_TIER = 'SOURCE_DOCUMENT' as const

/** Dedup key: the same deck dropped twice links to the existing artifact, not re-ingests. */
export function contentHashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ── Parsing (deterministic — documents are data) ──────────────────────────────
export interface ParsedSpan { ref: string; title?: string; text: string }
export interface ParsedArtifact { spans: ParsedSpan[]; summary: Record<string, unknown> }

export interface DocumentParser {
  supports(kind: string): boolean
  parse(input: { kind: string; filename: string; content: string }): ParsedArtifact
}

/** Zero-dep default: markdown/plaintext split into heading-addressable spans; a URL is one span. */
export const defaultTextParser: DocumentParser = {
  supports(kind) { return ['TEXT', 'MARKDOWN', 'MD', 'URL'].includes(kind.toUpperCase()) },
  parse({ kind, filename, content }) {
    const k = kind.toUpperCase()
    if (k === 'URL') {
      return { spans: [{ ref: 'url:0', title: filename, text: content.slice(0, 4000) }], summary: { kind: 'URL', spans: 1 } }
    }
    const spans = splitMarkdownSpans(content)
    return { spans, summary: { kind: k, spans: spans.length, title: spans[0]?.title ?? filename } }
  },
}

function splitMarkdownSpans(md: string): ParsedSpan[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const spans: ParsedSpan[] = []
  let title: string | undefined
  let buf: string[] = []
  let idx = 0
  const flush = () => {
    const text = buf.join('\n').trim()
    if (text || title) spans.push({ ref: `sec:${idx++}`, ...(title ? { title } : {}), text })
    buf = []
  }
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { flush(); title = (h[2] ?? '').trim() } else { buf.push(line) }
  }
  flush()
  return spans.length ? spans : [{ ref: 'sec:0', text: md.trim() }]
}

// ── Placement (spans → board objects) ─────────────────────────────────────────
export interface Placement { objectId: string; type: string; props: Record<string, unknown> }

/** One SourceCard for the artifact + one addressable SourceSpan per parsed span. */
export function planPlacement(artifactId: string, kind: string, filename: string, parsed: ParsedArtifact): Placement[] {
  const out: Placement[] = [{
    objectId: `art:${artifactId}`, type: 'SourceCard',
    props: { artifactId, kind, filename, spanCount: parsed.spans.length },
  }]
  for (const s of parsed.spans) {
    out.push({
      objectId: `art:${artifactId}:${s.ref}`, type: 'SourceSpan',
      props: { artifactId, ref: s.ref, title: s.title ?? null, preview: s.text.slice(0, 240) },
    })
  }
  return out
}

// ── Extraction (the injection boundary) ───────────────────────────────────────
export const EXTRACTED_CLAIM_KINDS = ['ASSERTION', 'ASSUMPTION', 'METRIC', 'COMMITMENT'] as const
export const extractedClaimSchema = z.object({
  kind: z.enum(EXTRACTED_CLAIM_KINDS),
  statement: z.string().trim().min(1).max(600),
  spanRef: z.string().max(120).optional(),
})
export const extractedClaimsEnvelopeSchema = z.object({ claims: z.array(extractedClaimSchema).max(100) })
export type ExtractedClaimInput = z.infer<typeof extractedClaimSchema>

/**
 * Validate extraction output as claim JSON ONLY. Strict per-claim (unknown kinds
 * dropped), lenient about the envelope (accepts {claims:[…]} or a bare array).
 * Anything that isn't a well-formed claim is discarded, never executed.
 */
export function parseExtractedClaims(raw: unknown): ExtractedClaimInput[] {
  const env = extractedClaimsEnvelopeSchema.safeParse(raw)
  if (env.success) return env.data.claims
  if (Array.isArray(raw)) {
    const out: ExtractedClaimInput[] = []
    for (const c of raw) {
      const r = extractedClaimSchema.safeParse(c)
      if (r.success) out.push(r.data)
    }
    return out
  }
  return []
}

export interface StagedClaim {
  id: string
  kind: string
  statement: string
  sourceRef: { artifactId: string; spanRef?: string }
  tier: typeof SOURCE_DOCUMENT_TIER
  status: 'STAGED' | 'ACCEPTED' | 'REJECTED'
}

/** Turn validated extractions into the staged claim rail (tier SOURCE_DOCUMENT). */
export function toStagedClaims(artifactId: string, claims: ExtractedClaimInput[], idFor: (i: number) => string): StagedClaim[] {
  return claims.map((c, i) => ({
    id: idFor(i),
    kind: c.kind,
    statement: c.statement,
    sourceRef: { artifactId, ...(c.spanRef ? { spanRef: c.spanRef } : {}) },
    tier: SOURCE_DOCUMENT_TIER,
    status: 'STAGED' as const,
  }))
}
