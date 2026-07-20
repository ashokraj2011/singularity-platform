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

function xmlAttribute(attrs: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${escaped}=(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return match?.[1] ?? match?.[2]
}

function boundedText(value: string, max = 800): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

async function parseDocx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const xml = await readZipEntry(zip, 'word/document.xml')
  const bodyWithoutTables = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, '')
  const paragraphs = [...bodyWithoutTables.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((match, index) => {
      const paragraph = match[1] ?? ''
      const text = xmlText(paragraph)
      const styleAttrs = /<w:pStyle\b([^>]*)\/?>(?:<\/w:pStyle>)?/.exec(paragraph)?.[1] ?? ''
      const style = xmlAttribute(styleAttrs, 'val')
      return text ? { ref: `docx:p:${index}`, ...(style ? { title: style } : {}), text } : null
    })
    .filter((span): span is ParsedSpan => Boolean(span))
  const tables = [...xml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)].slice(0, 100).map((match, tableIndex) => {
    const rows = [...(match[1] ?? '').matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map(row =>
      [...(row[1] ?? '').matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(cell => boundedText(xmlText(cell[1] ?? ''))).filter(Boolean).slice(0, 30),
    ).filter(row => row.length).slice(0, 100)
    return { index: tableIndex + 1, rows, columns: Math.max(0, ...rows.map(row => row.length)) }
  }).filter(table => table.rows.length)
  const tableSpans = tables.flatMap(table => table.rows.map((row, rowIndex) => ({
    ref: `docx:table:${table.index}:row:${rowIndex}`,
    title: `Table ${table.index} row ${rowIndex + 1}`,
    text: row.join(' | '),
  })))
  const media = Object.entries(zip.files).filter(([name, entry]) => /^word\/media\//i.test(name) && !entry.dir).length
  const headings = paragraphs.filter(span => /heading/i.test(span.title ?? '')).length
  const section = /<w:pgSz\b([^>]*)\/?>(?:<\/w:pgSz>)?/.exec(xml)?.[1]
  const spans = [...paragraphs, ...tableSpans]
  return {
    spans: spans.length ? spans : [{ ref: 'docx:0', title: filename, text: '' }],
    summary: {
      kind: 'DOCX', spans: spans.length, title: filename,
      layout: { paragraphs: paragraphs.length, headings, tables: tables.length, images: media, page: section ? { width: xmlAttribute(section, 'w'), height: xmlAttribute(section, 'h'), orientation: xmlAttribute(section, 'orient') ?? 'portrait' } : null },
      tables,
    },
  }
}

async function parsePptx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const names = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)/i)?.[1] ?? 0))
  if (!names.length) throw new Error('Presentation does not contain any slides.')
  const spans: ParsedSpan[] = []
  const slideMetadata: Array<Record<string, unknown>> = []
  for (const name of names) {
    const xml = await readZipEntry(zip, name)
    const shapes = [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)].map((match, shapeIndex) => {
      const shape = match[1] ?? ''
      const text = boundedText([...shape.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(item => decodeXml(item[1] ?? '')).join(' '))
      const off = /<a:off\b([^>]*)\/?>(?:<\/a:off>)?/.exec(shape)?.[1] ?? ''
      const ext = /<a:ext\b([^>]*)\/?>(?:<\/a:ext>)?/.exec(shape)?.[1] ?? ''
      const nameAttr = /<p:cNvPr\b([^>]*)\/?>(?:<\/p:cNvPr>)?/.exec(shape)?.[1] ?? ''
      return { index: shapeIndex + 1, name: xmlAttribute(nameAttr, 'name') ?? null, text, bounds: { x: xmlAttribute(off, 'x'), y: xmlAttribute(off, 'y'), width: xmlAttribute(ext, 'cx'), height: xmlAttribute(ext, 'cy') } }
    })
    const text = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1] ?? '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text) spans.push({ ref: `pptx:${spans.length}`, title: `Slide ${spans.length + 1}`, text })
    const slideNumber = Number(name.match(/slide(\d+)/i)?.[1] ?? slideMetadata.length + 1)
    slideMetadata.push({
      number: slideNumber,
      shapes: shapes.length,
      textShapes: shapes.filter(shape => Boolean(shape.text)).length,
      images: (xml.match(/<p:pic\b/g) ?? []).length,
      charts: (xml.match(/<c:chart\b/g) ?? []).length,
      geometry: shapes.slice(0, 80),
    })
  }
  return {
    spans: spans.length ? spans : [{ ref: 'pptx:0', title: filename, text: '' }],
    summary: { kind: 'PPTX', slides: names.length, spans: spans.length, title: filename, layout: slideMetadata },
  }
}

function sharedStringsFromXml(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1] ?? ''))
}

async function parseXlsx(content: Buffer, filename: string): Promise<ParsedArtifact> {
  const zip = await JSZip.loadAsync(content)
  const sharedEntry = zip.file('xl/sharedStrings.xml')
  const shared = sharedEntry ? sharedStringsFromXml(await sharedEntry.async('string')) : []
  const workbookEntry = zip.file('xl/workbook.xml')
  const workbookXml = workbookEntry ? await workbookEntry.async('string') : ''
  const sheetLabels = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/g)].map(match => xmlAttribute(match[1] ?? '', 'name') ?? '')
  const tableEntries = Object.keys(zip.files).filter(name => /^xl\/tables\/table\d+\.xml$/i.test(name))
  const tables = await Promise.all(tableEntries.slice(0, 100).map(async name => {
    const tableXml = await readZipEntry(zip, name)
    const attrs = /<table\b([^>]*)>/.exec(tableXml)?.[1] ?? ''
    return { name: xmlAttribute(attrs, 'displayName') ?? name.split('/').pop()?.replace(/\.xml$/i, '') ?? name, ref: xmlAttribute(attrs, 'ref') ?? null }
  }))
  const sheets = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/i)?.[1] ?? 0))
  if (!sheets.length) throw new Error('Workbook does not contain any worksheets.')
  const spans: ParsedSpan[] = []
  const sheetMetadata: Array<Record<string, unknown>> = []
  let formulaCount = 0
  for (const [sheetIndex, name] of sheets.entries()) {
    const xml = await readZipEntry(zip, name)
    const cellRows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].slice(0, 500).map(row => {
      const rowAttrs = row[1] ?? ''
      const cells = [...(row[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].slice(0, 100).map(cell => {
        const attrs = cell[1] ?? ''
        const body = cell[2] ?? ''
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
        const decoded = decodeXml(value)
        const ref = xmlAttribute(attrs, 'r') ?? null
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1] ?? null
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1]
        const cellValue = inline !== undefined ? xmlText(inline) : /\bt="s"/.test(attrs) ? (shared[Number(decoded)] ?? decoded) : decoded
        if (formula) formulaCount += 1
        return { ref, value: boundedText(cellValue, 500), formula: formula ? boundedText(decodeXml(formula), 500) : null }
      })
      return { row: xmlAttribute(rowAttrs, 'r') ?? null, cells }
    })
    const rows = cellRows.map(row => row.cells.map(cell => `${cell.ref ? `${cell.ref}=` : ''}${cell.value}${cell.formula ? ` [formula: ${cell.formula}]` : ''}`).join(' | ')).filter(Boolean)
    const sheetName = sheetLabels[sheetIndex] || name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/i, '')
    if (rows.length) spans.push({ ref: `xlsx:${spans.length}`, title: sheetName, text: rows.join('\n') })
    sheetMetadata.push({ name: sheetName, rows: cellRows.length, cells: cellRows.reduce((total, row) => total + row.cells.length, 0), formulas: cellRows.flatMap(row => row.cells).filter(cell => Boolean(cell.formula)).slice(0, 100).map(cell => ({ ref: cell.ref, expression: cell.formula, cachedValue: cell.value })), dimension: xmlAttribute(/<dimension\b([^>]*)\/?>(?:<\/dimension>)?/.exec(xml)?.[1] ?? '', 'ref') ?? null, mergedRanges: [...xml.matchAll(/<mergeCell\b([^>]*)\/?>(?:<\/mergeCell>)?/g)].slice(0, 200).map(match => xmlAttribute(match[1] ?? '', 'ref')).filter(Boolean) })
  }
  return {
    spans: spans.length ? spans : [{ ref: 'xlsx:0', title: filename, text: '' }],
    summary: { kind: 'XLSX', sheets: sheets.length, spans: spans.length, title: filename, formulas: formulaCount, worksheets: sheetMetadata, tables },
  }
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
