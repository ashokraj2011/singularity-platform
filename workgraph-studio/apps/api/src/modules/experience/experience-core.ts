import { createHash } from 'crypto'

export const INTAKE_STAGES = ['PROBLEM', 'BELIEFS', 'SUCCESS', 'CONSTRAINTS', 'CONTEXT'] as const
export type IntakeStage = typeof INTAKE_STAGES[number]
export type AttentionBand = 'BLOCKING' | 'DECIDE' | 'REVIEW' | 'DIGEST'

export function boundedScore(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(0, Math.min(5, Math.round(value * 100) / 100))
}

export function attentionPriority(stakes: number, uncertainty: number, urgency: number): number {
  return Math.round(boundedScore(stakes) * boundedScore(uncertainty) * boundedScore(urgency) * 100) / 100
}

export function attentionBand(input: { blocking?: boolean; decision?: boolean; stakes: number; priority: number }): AttentionBand {
  if (input.blocking) return 'BLOCKING'
  if (input.decision) return 'DECIDE'
  if (input.stakes >= 3 || input.priority >= 18) return 'REVIEW'
  return 'DIGEST'
}

export function attentionCanAcknowledge(band: AttentionBand): boolean {
  return band === 'REVIEW' || band === 'DIGEST'
}

export function rankingReason(stakes: number, uncertainty: number, urgency: number): string {
  return `Ranked ${attentionPriority(stakes, uncertainty, urgency).toFixed(2)} from stakes ${boundedScore(stakes).toFixed(1)} x uncertainty ${boundedScore(uncertainty).toFixed(1)} x urgency ${boundedScore(urgency).toFixed(1)}.`
}

export function posteriorVariance(alpha: number, beta: number): number {
  const total = alpha + beta
  if (alpha <= 0 || beta <= 0 || total <= 0) return 0.25
  return (alpha * beta) / ((total * total) * (total + 1))
}

export function nextIntakeStage(stage: IntakeStage): IntakeStage | null {
  const index = INTAKE_STAGES.indexOf(stage)
  return index < 0 || index === INTAKE_STAGES.length - 1 ? null : INTAKE_STAGES[index + 1]!
}

export function stageReadback(stage: IntakeStage, text: string, confidence: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const prefix: Record<IntakeStage, string> = {
    PROBLEM: 'The problem to solve is',
    BELIEFS: 'The beliefs to test are',
    SUCCESS: 'Success will be recognized by',
    CONSTRAINTS: 'The boundaries are',
    CONTEXT: 'The relevant context is',
  }
  return `${prefix[stage]}: ${clean} (speaker confidence ${Math.round(confidence * 100)}%).`
}

export function splitStatements(text: string, limit = 12): string[] {
  return text
    .split(/(?:\n+|[.!?]+\s+)/)
    .map(item => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(item => item.length >= 8)
    .slice(0, limit)
}

export interface ArtifactClaim {
  id: string
  kind: string
  statement: string
  sourceRef: { artifactId: string; spanRef?: string }
  tier?: string
  status?: string
}

export interface ArtifactForValidation {
  id: string
  filename: string
  kind: string
  status: string
  contentHash: string
  sourceSpans: Array<{ ref: string; title?: string | null; text: string }>
  extractedClaims: ArtifactClaim[]
}

export interface ValidationFinding {
  id: string
  kind: 'COMPLETENESS' | 'CONSISTENCY' | 'STALENESS' | 'REQUIREMENT_QUALITY'
  severity: 'INFO' | 'WARNING' | 'ERROR'
  title: string
  consequence: string
  citationRefs: string[]
  suggestedRewrite?: string
}

export interface ValidationTension {
  id: string
  status: 'OPEN'
  left: { statement: string; citationRef: string }
  right: { statement: string; citationRef: string }
  reason: string
}

function citationOf(claim: ArtifactClaim): string {
  return `${claim.sourceRef.artifactId}#${claim.sourceRef.spanRef ?? claim.id}`
}

function contradictionKey(statement: string): { key: string; negative: boolean } {
  const lower = statement.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const negative = /\b(no|not|never|cannot|must not|should not|without)\b/.test(lower)
  const key = lower.replace(/\b(no|not|never|cannot|must|should|without)\b/g, '').replace(/\s+/g, ' ').trim()
  return { key, negative }
}

function vagueRequirement(statement: string): boolean {
  return /\b(fast|easy|simple|user friendly|robust|scalable|soon|appropriate|as needed|etc)\b/i.test(statement)
    || statement.trim().split(/\s+/).length < 5
}

export function validateArtifactPile(artifacts: ArtifactForValidation[]) {
  const taxonomy = artifacts.map(artifact => ({
    artifactId: artifact.id,
    filename: artifact.filename,
    declaredKind: artifact.kind,
    recognizedType: recognizeDocumentType(artifact.filename, artifact.kind),
    confidence: 1,
    humanConfirmable: true,
  }))
  const findings: ValidationFinding[] = []
  const tensions: ValidationTension[] = []
  const claims = artifacts.flatMap(artifact => artifact.extractedClaims)

  for (const artifact of artifacts) {
    const rootCitation = `${artifact.id}#${artifact.sourceSpans[0]?.ref ?? 'document'}`
    if (artifact.status !== 'COMPLETED') {
      findings.push({ id: `incomplete:${artifact.id}`, kind: 'COMPLETENESS', severity: 'ERROR', title: `${artifact.filename} has not completed ingestion`, consequence: 'The pile cannot be treated as a complete source set.', citationRefs: [rootCitation] })
    } else if (artifact.extractedClaims.length === 0) {
      findings.push({ id: `empty:${artifact.id}`, kind: 'COMPLETENESS', severity: 'WARNING', title: `${artifact.filename} produced no addressable claims`, consequence: 'Important assertions may remain untraceable until a human reviews the source.', citationRefs: [rootCitation] })
    }
    const years = artifact.sourceSpans.flatMap(span => span.text.match(/\b(19|20)\d{2}\b/g) ?? []).map(Number)
    const newest = years.length ? Math.max(...years) : null
    if (newest != null && newest < new Date().getUTCFullYear() - 2) {
      findings.push({ id: `stale:${artifact.id}`, kind: 'STALENESS', severity: 'WARNING', title: `${artifact.filename} may be stale`, consequence: `The newest explicit year found is ${newest}; confirm whether this source is superseded.`, citationRefs: [rootCitation] })
    }
  }

  for (const claim of claims) {
    if (!['COMMITMENT', 'METRIC'].includes(claim.kind) || !vagueRequirement(claim.statement)) continue
    findings.push({
      id: `quality:${claim.id}`,
      kind: 'REQUIREMENT_QUALITY',
      severity: 'WARNING',
      title: 'Potentially untestable requirement language',
      consequence: 'A downstream verifier may be unable to prove completion objectively.',
      citationRefs: [citationOf(claim)],
      suggestedRewrite: `Define a measurable threshold and observable outcome for: ${claim.statement}`,
    })
  }

  const keyed = claims.map(claim => ({ claim, ...contradictionKey(claim.statement) })).filter(item => item.key.length >= 12)
  for (let leftIndex = 0; leftIndex < keyed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < keyed.length; rightIndex += 1) {
      const left = keyed[leftIndex]!
      const right = keyed[rightIndex]!
      if (left.negative === right.negative) continue
      const overlap = tokenOverlap(left.key, right.key)
      if (overlap < 0.72) continue
      tensions.push({
        id: `tension:${left.claim.id}:${right.claim.id}`,
        status: 'OPEN',
        left: { statement: left.claim.statement, citationRef: citationOf(left.claim) },
        right: { statement: right.claim.statement, citationRef: citationOf(right.claim) },
        reason: 'The sources make materially opposing assertions. A human decision is required; the platform will not choose silently.',
      })
    }
  }

  const citations = [...new Set([
    ...findings.flatMap(finding => finding.citationRefs),
    ...tensions.flatMap(tension => [tension.left.citationRef, tension.right.citationRef]),
  ])]
  return { taxonomy, findings, tensions, citations }
}

function recognizeDocumentType(filename: string, kind: string): string {
  const value = `${filename} ${kind}`.toLowerCase()
  if (/\bbrd\b|business.requirement/.test(value)) return 'BRD'
  if (/\bprd\b|product.requirement/.test(value)) return 'PRD'
  if (/design|architecture|adr/.test(value)) return 'DESIGN'
  if (/minute|meeting|transcript/.test(value)) return 'MINUTES'
  if (/jira|alm|backlog/.test(value)) return 'ALM_EXPORT'
  if (/contract|agreement/.test(value)) return 'CONTRACT'
  if (/runbook|operation/.test(value)) return 'RUNBOOK'
  if (/thread|chat|email/.test(value)) return 'THREAD'
  if (/model|schema/.test(value)) return 'MODEL'
  return 'UNCLASSIFIED'
}

function tokenOverlap(left: string, right: string): number {
  const a = new Set(left.split(' ').filter(token => token.length > 2))
  const b = new Set(right.split(' ').filter(token => token.length > 2))
  if (!a.size || !b.size) return 0
  const intersection = [...a].filter(token => b.has(token)).length
  return intersection / Math.min(a.size, b.size)
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function assertCitedSentences(sentences: Array<{ text: string; citationRefs: string[] }>, max = 8): void {
  if (sentences.length > max) throw new Error(`Narrative exceeds the ${max}-sentence limit.`)
  if (sentences.some(sentence => !sentence.text.trim() || sentence.citationRefs.length === 0)) {
    throw new Error('Every generated sentence must cite at least one durable source.')
  }
}
