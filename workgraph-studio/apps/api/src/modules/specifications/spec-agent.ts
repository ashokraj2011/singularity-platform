import type { SpecificationPackageBody } from './specification.schemas'

/**
 * Agent Storm — conversational spec authoring (Phase C). The pure pieces: the system prompt, the
 * task builder (conversation + current-spec context), parsing the model's JSON reply + proposals,
 * and applying a proposal to the package body. No I/O; the model call + persistence live in the
 * service. A "proposal" is a spec fragment the user can apply in one click.
 */

export type ProposalKind = 'requirement' | 'acceptance' | 'test'
export interface SpecProposal { kind: ProposalKind; data: any; label?: string }

export interface ConverseMessage { role: 'user' | 'assistant'; content: string }

export function specAgentSystemPrompt(): string {
  return [
    'You are Agent Storm, a pair-author for software specifications. You discuss the spec with the',
    'user and, when useful, PROPOSE concrete additions they can apply in one click.',
    '',
    'Reply with STRICT JSON only — no prose outside it:',
    '{',
    '  "reply": "a short conversational message",',
    '  "proposals": [',
    '    { "kind": "requirement", "label": "…", "data": { "id": "REQ-N", "priority": "MUST|SHOULD|MAY",',
    '        "type": "FUNCTIONAL", "statement": "…", "acceptanceCriterionIds": [], "testObligationIds": [], "sourceIds": [] } },',
    '    { "kind": "acceptance", "label": "…", "data": { "id": "AC-N", "requirementIds": ["REQ-N"], "given": [], "when": [], "then": [] } },',
    '    { "kind": "test", "label": "…", "data": { "id": "T-N", "verifies": ["REQ-N"], "kind": "behavior", "description": "…" } }',
    '  ]',
    '}',
    '',
    'Use fresh, non-colliding ids. Omit "proposals" (or use []) when just answering. Keep every MUST',
    'requirement paired with at least one acceptance criterion.',
  ].join('\n')
}

export function buildConverseTask(messages: ConverseMessage[], spec: { summary?: string; requirements?: any[] } | null): string {
  const parts: string[] = []
  if (spec) {
    parts.push('CURRENT SPECIFICATION')
    if (spec.summary) parts.push(`Summary: ${spec.summary}`)
    const reqs = (spec.requirements ?? []).map((r) => `- ${r.id} [${r.priority}] ${r.statement}`).join('\n')
    parts.push(`Requirements:\n${reqs || '(none yet)'}`)
    parts.push('')
  }
  parts.push('CONVERSATION')
  for (const m of messages.slice(-12)) parts.push(`${m.role === 'user' ? 'User' : 'Agent Storm'}: ${m.content}`)
  parts.push('')
  parts.push('Respond with the JSON now.')
  return parts.join('\n')
}

export function extractJsonObject(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const c = fence ? fence[1] : text
  const s = c.indexOf('{'), e = c.lastIndexOf('}')
  if (s === -1 || e < s) return null
  try { return JSON.parse(c.slice(s, e + 1)) } catch { return null }
}

export function parseAgentResponse(text: string): { reply: string; proposals: SpecProposal[] } {
  const json = extractJsonObject(text)
  if (json && typeof json === 'object') {
    const o = json as any
    const proposals: SpecProposal[] = Array.isArray(o.proposals)
      ? o.proposals
          .filter((p: any) => p && ['requirement', 'acceptance', 'test'].includes(p.kind) && p.data && typeof p.data === 'object')
          .map((p: any) => ({ kind: p.kind, data: p.data, label: p.label ? String(p.label) : undefined }))
      : []
    const reply = String(o.reply ?? '').trim()
    return { reply: reply || 'Here you go.', proposals }
  }
  return { reply: text.trim() || 'Done.', proposals: [] }
}

const SECTION: Record<ProposalKind, keyof SpecificationPackageBody> = { requirement: 'requirements', acceptance: 'acceptanceCriteria', test: 'testObligations' }

/** Merge a proposal into the body, returning the partial-body patch (the one changed section). */
export function applyProposal(body: SpecificationPackageBody, proposal: SpecProposal): Partial<SpecificationPackageBody> {
  const section = SECTION[proposal.kind]
  const current: any[] = (body as any)[section] ?? []
  const id = proposal.data?.id
  const next = id && current.some((x) => x.id === id)
    ? current.map((x) => (x.id === id ? { ...x, ...proposal.data } : x)) // replace by id
    : [...current, proposal.data]
  return { [section]: next } as Partial<SpecificationPackageBody>
}
