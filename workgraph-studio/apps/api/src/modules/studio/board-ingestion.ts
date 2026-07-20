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
 * Binary parsers (PDF/DOCX/PPTX/XLSX) are DocumentParser adapters in the default
 * registry. Figma and other provider-specific formats remain injectable adapters.
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import JSZip from 'jszip'
import { PDFParse } from 'pdf-parse'

export const SOURCE_DOCUMENT_TIER = 'SOURCE_DOCUMENT' as const

/** Dedup key: the same deck dropped twice links to the existing artifact, not re-ingests. */
export type IngestContent = string | Buffer

export function contentHashOf(content: IngestContent): string {
  return createHash('sha256').update(content).digest('hex')
}

// ── Parsing (deterministic — documents are data) ──────────────────────────────
export interface ParsedSpan { ref: string; title?: string; text: string }
export interface ParsedArtifact { spans: ParsedSpan[]; summary: Record<string, unknown> }

export interface DocumentParser {
  supports(kind: string): boolean
  parse(input: { kind: string; filename: string; content: IngestContent }): ParsedArtifact | Promise<ParsedArtifact>
}

export const BINARY_DOCUMENT_KINDS = ['PDF', 'DOCX', 'PPTX', 'XLSX'] as const

export function isBinaryDocumentKind(kind: string): boolean {
  return (BINARY_DOCUMENT_KINDS as readonly string[]).includes(kind.toUpperCase())
}

/** Zero-dep default: markdown/plaintext split into heading-addressable spans; a URL is one span. */
export const defaultTextParser: DocumentParser = {
  supports(kind) { return ['TEXT', 'MARKDOWN', 'MD', 'URL'].includes(kind.toUpperCase()) },
  parse({ kind, filename, content }) {
    const text = typeof content === 'string' ? content : content.toString('utf8')
    const k = kind.toUpperCase()
    if (k === 'URL') {
      return { spans: [{ ref: 'url:0', title: filename, text: text.slice(0, 4000) }], summary: { kind: 'URL', spans: 1 } }
    }
    const spans = splitMarkdownSpans(text)
    return { spans, summary: { kind: k, spans: spans.length, title: spans[0]?.title ?? filename } }
  },
}

/** Decode the small XML vocabulary used by Office Open XML documents. */
function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function xmlText(xml: string): string {
  return decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<a:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

async function readZipEntry(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name)
  if (!entry) throw new Error(`Office document is missing ${name}.`)
  return entry.async('string')
}

async function parseDocx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const xml = await readZipEntry(zip, 'word/document.xml')
  const spans = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((match, index) => {
      const paragraph = match[1] ?? ''
      const text = xmlText(paragraph)
      const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraph)?.[1]
      return text ? { ref: `docx:p:${index}`, ...(style ? { title: style } : {}), text } : null
    })
    .filter((span): span is ParsedSpan => Boolean(span))
  return { spans: spans.length ? spans : [{ ref: 'docx:0', title: filename, text: '' }], summary: { kind: 'DOCX', spans: spans.length, title: filename } }
}

async function parsePptx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const names = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)/i)?.[1] ?? 0))
  if (!names.length) throw new Error('Presentation does not contain any slides.')
  const spans: ParsedSpan[] = []
  for (const name of names) {
    const xml = await readZipEntry(zip, name)
    const text = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1] ?? '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text) spans.push({ ref: `pptx:${spans.length}`, title: `Slide ${spans.length + 1}`, text })
  }
  return { spans: spans.length ? spans : [{ ref: 'pptx:0', title: filename, text: '' }], summary: { kind: 'PPTX', slides: names.length, spans: spans.length, title: filename } }
}

function sharedStringsFromXml(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1] ?? ''))
}

async function parseXlsx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const sharedEntry = zip.file('xl/sharedStrings.xml')
  const shared = sharedEntry ? sharedStringsFromXml(await sharedEntry.async('string')) : []
  const sheets = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/i)?.[1] ?? 0))
  if (!sheets.length) throw new Error('Workbook does not contain any worksheets.')
  const spans: ParsedSpan[] = []
  for (const name of sheets) {
    const xml = await readZipEntry(zip, name)
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => {
      return [...(row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
        const attrs = cell[1] ?? ''
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2] ?? '')?.[1] ?? ''
        const decoded = decodeXml(value)
        return /\bt="s"/.test(attrs) ? (shared[Number(decoded)] ?? decoded) : decoded
      }).join(' | ')
    }).filter(Boolean)
    if (rows.length) spans.push({ ref: `xlsx:${spans.length}`, title: name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/i, ''), text: rows.join('\n') })
  }
  return { spans: spans.length ? spans : [{ ref: 'xlsx:0', title: filename, text: '' }], summary: { kind: 'XLSX', sheets: sheets.length, spans: spans.length, title: filename } }
}

async function parsePdf(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const parser = new PDFParse({ data: content })
  try {
    const result = await parser.getText()
    const text = String(result.text ?? '').trim()
    return { spans: [{ ref: 'pdf:0', title: filename, text }], summary: { kind: 'PDF', pages: result.total ?? null, spans: 1, title: filename } }
  } finally {
    await parser.destroy()
  }
}

export const defaultDocumentParser: DocumentParser = {
  supports(kind) { return defaultTextParser.supports(kind) || isBinaryDocumentKind(kind) },
  parse({ kind, filename, content }) {
    const upper = kind.toUpperCase()
    if (!isBinaryDocumentKind(upper)) return defaultTextParser.parse({ kind: upper, filename, content })
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    if (upper === 'DOCX') return parseDocx(buffer, filename)
    if (upper === 'PPTX') return parsePptx(buffer, filename)
    if (upper === 'XLSX') return parseXlsx(buffer, filename)
    return parsePdf(buffer, filename)
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

export type ExtractedClaimsParseStatus = 'SUCCEEDED' | 'VALID_EMPTY' | 'PARTIAL' | 'FAILED'
export interface ExtractedClaimsParseResult {
  status: ExtractedClaimsParseStatus
  claims: ExtractedClaimInput[]
}

/**
 * Validate extraction output as claim JSON ONLY. Strict per-claim (unknown kinds
 * dropped), lenient about the envelope (accepts {claims:[…]} or a bare array).
 * Anything that isn't a well-formed claim is discarded, never executed.
 */
export function parseExtractedClaimsResult(raw: unknown): ExtractedClaimsParseResult {
  const env = extractedClaimsEnvelopeSchema.safeParse(raw)
  if (env.success) {
    return {
      status: env.data.claims.length ? 'SUCCEEDED' : 'VALID_EMPTY',
      claims: env.data.claims,
    }
  }
  if (Array.isArray(raw)) {
    const out: ExtractedClaimInput[] = []
    for (const c of raw) {
      const r = extractedClaimSchema.safeParse(c)
      if (r.success) out.push(r.data)
    }
    if (raw.length === 0) return { status: 'VALID_EMPTY', claims: [] }
    if (out.length === 0) return { status: 'FAILED', claims: [] }
    return { status: out.length === raw.length ? 'SUCCEEDED' : 'PARTIAL', claims: out }
  }
  return { status: 'FAILED', claims: [] }
}

export function parseExtractedClaims(raw: unknown): ExtractedClaimInput[] {
  return parseExtractedClaimsResult(raw).claims
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
