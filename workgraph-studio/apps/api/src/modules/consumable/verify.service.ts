// Verifier agent — shared by the on-demand /consumables/:id/verify endpoint and
// the VERIFIER workflow node. Reads the standards/policies a document must satisfy
// (the run's acceptance criteria / definition-of-done + any configured policy + a
// baseline doc standard), then LLM-judges the document against them (AUDIT_JUDGE
// model via llm-routing). Falls back to deterministic structural checks when no
// LLM is available or its output can't be parsed, so verification never hard-fails.
import { prisma } from '../../lib/prisma'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { resolveLlmRouting } from '../llm-routing/resolve'

export type Verdict = {
  method: string
  passed: boolean
  findings: string[]
  rationale?: string
  standardsSummary?: string
  modelAlias?: string | null
  verifiedById: string
  verifiedAt: string
}

function structuralFindings(content: string): string[] {
  const findings: string[] = []
  if (content.trim().length < 50) findings.push('Very short (<50 chars) — likely incomplete.')
  if (!/#{1,6}\s|(^|\n)\s*[-*]\s/.test(content)) findings.push('No headings or bullet lists — add structure.')
  if (/\b(TODO|TBD|FIXME|XXX)\b/i.test(content)) findings.push('Contains TODO/TBD/FIXME placeholders.')
  return findings
}

async function gatherStandards(
  consumable: { instanceId: string | null },
): Promise<{ text: string; capabilityId: string | null }> {
  const parts: string[] = []
  let capabilityId: string | null = null
  if (consumable.instanceId) {
    const inst = await prisma.workflowInstance
      .findUnique({ where: { id: consumable.instanceId }, select: { context: true } })
      .catch(() => null)
    const ctx = (inst?.context ?? {}) as Record<string, unknown>
    const vars = (ctx._vars ?? ctx.vars ?? {}) as Record<string, unknown>
    const globals = (ctx._globals ?? ctx.globals ?? {}) as Record<string, unknown>
    if (typeof vars.parentCapabilityId === 'string' && vars.parentCapabilityId.trim()) {
      capabilityId = vars.parentCapabilityId.trim()
    }
    const pick = (k: string): string | undefined =>
      [vars[k], globals[k]].find(v => typeof v === 'string' && (v as string).trim()) as string | undefined
    const ac = pick('acceptanceCriteria')
    const dod = pick('definitionOfDone')
    const policy = pick('verificationPolicy') ?? pick('reviewPolicy')
    if (ac) parts.push(`Acceptance criteria:\n${ac}`)
    if (dod) parts.push(`Definition of done:\n${dod}`)
    if (policy) parts.push(`Verification policy:\n${policy}`)
  }
  parts.push(
    'Baseline document standards:\n' +
    '- Complete and self-contained for its stated purpose; no placeholder text (TODO/TBD/FIXME).\n' +
    '- Well structured (clear headings / sections) and internally consistent.\n' +
    '- Specific and unambiguous; claims are actionable and testable where applicable.',
  )
  return { text: parts.join('\n\n'), capabilityId }
}

function parseVerdict(text: string): { passed: boolean; findings: string[]; rationale?: string } | null {
  const m = text?.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    if (typeof o.passed !== 'boolean') return null
    const findings = Array.isArray(o.findings)
      ? o.findings.filter(f => typeof f === 'string').map(f => String(f))
      : []
    return { passed: o.passed, findings, rationale: typeof o.rationale === 'string' ? o.rationale : undefined }
  } catch {
    return null
  }
}

// Optional extra policy text (e.g. a VERIFIER node's configured criteria) merged
// into the standards block.
export async function runVerification(
  consumable: { id: string; name: string; instanceId: string | null; formData: unknown },
  userId: string,
  extraPolicy?: string,
): Promise<Verdict> {
  const content = String((consumable.formData as Record<string, unknown> | null)?.content ?? '')
  const verifiedAt = new Date().toISOString()
  if (!content.trim()) {
    return { method: 'structural-v1', passed: false, findings: ['Document is empty.'], modelAlias: null, verifiedById: userId, verifiedAt }
  }

  const gathered = await gatherStandards(consumable)
  const capabilityId = gathered.capabilityId
  const standards = extraPolicy?.trim()
    ? `Stage verification criteria:\n${extraPolicy.trim()}\n\n${gathered.text}`
    : gathered.text
  const modelAlias = await resolveLlmRouting('AUDIT_JUDGE', { userId, capabilityId })

  const systemPrompt =
    'You are a meticulous compliance verifier. You are given a DOCUMENT and the STANDARDS/POLICIES it must satisfy. ' +
    'Judge ONLY whether the document meets the standards — do not rewrite the document. ' +
    'Respond with ONLY a JSON object (no prose, no code fence) of the form: ' +
    '{"passed": boolean, "findings": string[], "rationale": string}. ' +
    'findings = specific, actionable gaps against the standards (empty array when it passes). ' +
    'rationale = one or two sentences summarising the decision. Pass only when the document genuinely meets the standards.'
  const task =
    `## Standards / policies\n${standards}\n\n## Document: ${consumable.name}\n${content.slice(0, 24000)}`

  try {
    const resp = await contextFabricClient.executeGovernedTurn({
      system_prompt: systemPrompt,
      task,
      model_overrides: { modelAlias: modelAlias ?? undefined, temperature: 0, maxOutputTokens: 1200 },
      limits: { timeoutSec: 120 },
      run_context: { userId, capability_id: capabilityId ?? undefined, purpose: 'document_verification' },
    })
    const parsed = parseVerdict(resp.finalResponse ?? '')
    if (parsed) {
      return {
        method: 'policy-llm-v1',
        passed: parsed.passed,
        findings: parsed.findings,
        rationale: parsed.rationale,
        standardsSummary: standards.slice(0, 600),
        modelAlias: modelAlias ?? null,
        verifiedById: userId,
        verifiedAt,
      }
    }
  } catch {
    // fall through to the deterministic checks
  }
  const findings = structuralFindings(content)
  return { method: 'structural-fallback', passed: findings.length === 0, findings, modelAlias: modelAlias ?? null, verifiedById: userId, verifiedAt }
}
