/**
 * Planner — describe a goal, an agent breaks it into work items (some assigned
 * to child capabilities), an independent critic reviews the breakdown, then the
 * user commits and the items land in the owning capability's inbox.
 *
 * Two phases:
 *   breakdownGoal()  → preview only. Calls context-fabric (planner) → parse +
 *                      sanitize → deterministic checks → context-fabric (critic).
 *                      Creates NOTHING.
 *   commitBreakdown()→ loops createWorkItem for the (user-edited) items.
 *
 * The pure helpers (extractJsonBlock, parsePlannerPlan, sanitizeAssignments,
 * findDuplicatePairs, coverageGaps, parseCritic, aggregateUsage) are exported so
 * they unit-test without the LLM or the DB.
 */
import { z } from 'zod'
import { contextFabricClient, type ExecuteResponse } from '../../lib/context-fabric/client'
import { listCapabilityRelationships, getCapability } from '../../lib/iam/client'
import { createWorkItem } from '../work-items/work-items.service'

export const URGENCY = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const

export const plannerItemSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(8).max(4000),
  capabilityId: z.string().trim().min(1),
  priority: z.coerce.number().int().min(0).max(100).catch(50).default(50),
  urgency: z.enum(URGENCY).catch('NORMAL').default('NORMAL'),
  estimate: z.string().trim().max(80).optional(),
  rationale: z.string().trim().max(600).optional(),
})
export type PlannerItem = z.infer<typeof plannerItemSchema>

export const plannerPlanSchema = z.object({
  version: z.literal(1).optional(),
  items: z.array(plannerItemSchema).min(1).max(40),
})

export const criticIssueSchema = z.object({
  dimension: z.string().trim().min(1),
  itemRef: z.string().trim().default('plan'),
  message: z.string().trim().min(1),
  fix: z.string().trim().optional(),
})
export const criticSchema = z.object({
  verdict: z.enum(['pass', 'warn', 'fail']).catch('warn').default('warn'),
  issues: z.array(criticIssueSchema).default([]),
})
export type CriticResult = z.infer<typeof criticSchema>

export interface AssignableCapability { id: string; name: string }

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested; no LLM, no DB)
// ────────────────────────────────────────────────────────────────────────────

/** Pull a JSON object out of an LLM response: ```json fences, or first { … last }. */
export function extractJsonBlock(text: string): string {
  if (!text) return ''
  const t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first >= 0 && last > first) return t.slice(first, last + 1)
  return t
}

const STOPWORDS = new Set(
  ('the a an and or to of for in on with into using build create implement add support new system that this ' +
    'we need want it as be by able from will would should our your their can has have are is at via per each ' +
    'when then than them they all any more most must not but also which while where what who how also include')
    .split(/\s+/),
)

/** Lowercased significant tokens (len ≥ 3, not stopwords). */
export function significantWords(s: string): string[] {
  return (String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Pairs of items whose word-sets overlap ≥ threshold — a near-duplicate signal. */
export function findDuplicatePairs(
  items: Array<{ title: string; description: string }>,
  threshold = 0.6,
): Array<{ a: number; b: number; score: number }> {
  const sets = items.map((it) => new Set(significantWords(`${it.title} ${it.description}`)))
  const out: Array<{ a: number; b: number; score: number }> = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = jaccard(sets[i], sets[j])
      if (s >= threshold) out.push({ a: i, b: j, score: Number(s.toFixed(2)) })
    }
  }
  return out
}

/** Significant words in the goal that appear in NO item — a cheap (noisy) completeness hint. */
export function coverageGaps(
  description: string,
  items: Array<{ title: string; description: string }>,
  max = 8,
): string[] {
  const covered = new Set<string>()
  for (const it of items) for (const w of significantWords(`${it.title} ${it.description}`)) covered.add(w)
  const gaps: string[] = []
  const seen = new Set<string>()
  for (const w of significantWords(description)) {
    if (!covered.has(w) && !seen.has(w)) {
      seen.add(w)
      gaps.push(w)
    }
  }
  return gaps.slice(0, max)
}

/** Clamp each item's capabilityId to the allowed set; anything else → home. */
export function sanitizeAssignments(
  items: PlannerItem[],
  allowedIds: Set<string>,
  homeId: string,
): { items: PlannerItem[]; repaired: number } {
  let repaired = 0
  const out = items.map((it) => {
    if (allowedIds.has(it.capabilityId)) return it
    repaired++
    return { ...it, capabilityId: homeId }
  })
  return { items: out, repaired }
}

export function parsePlannerPlan(raw: string): { ok: true; items: PlannerItem[] } | { ok: false; error: string } {
  try {
    const json = JSON.parse(extractJsonBlock(raw))
    const parsed = plannerPlanSchema.parse(json)
    return { ok: true, items: parsed.items }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Parse the critic. Never throws — unparseable critique degrades to a manual-review warn. */
export function parseCritic(raw: string): CriticResult {
  try {
    return criticSchema.parse(JSON.parse(extractJsonBlock(raw)))
  } catch {
    return {
      verdict: 'warn',
      issues: [{ dimension: 'meta', itemRef: 'plan', message: 'Critic output could not be parsed; review the breakdown manually.' }],
    }
  }
}

export interface PlannerUsage { inputTokens: number; outputTokens: number; estimatedCostUsd: number; calls: number }
export function aggregateUsage(responses: Array<ExecuteResponse | null | undefined>): PlannerUsage {
  let inputTokens = 0
  let outputTokens = 0
  let estimatedCostUsd = 0
  let calls = 0
  for (const r of responses) {
    if (!r) continue
    calls++
    const u = r.usage
    inputTokens += Number(u?.inputTokens ?? r.tokensUsed?.input ?? 0) || 0
    outputTokens += Number(u?.outputTokens ?? r.tokensUsed?.output ?? 0) || 0
    estimatedCostUsd += Number(u?.estimatedCost ?? r.tokensUsed?.estimatedCost ?? 0) || 0
  }
  return { inputTokens, outputTokens, estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)), calls }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompts
// ────────────────────────────────────────────────────────────────────────────

function plannerPrompt(maxItems: number): string {
  return [
    'You decompose a high-level GOAL into concrete, independently-actionable work items.',
    'You are given a list of CAPABILITIES (id + name); the first is the HOME capability.',
    '',
    'For each work item output:',
    '- title: short imperative (3–200 chars).',
    '- description: 2–5 sentences, acceptance-oriented (what "done" looks like).',
    '- capabilityId: the SINGLE best-fit capability id, chosen ONLY from the provided list. Never invent an id. If unsure, use the HOME id.',
    '- priority: integer 0–100 (50 = normal).',
    '- urgency: one of LOW, NORMAL, HIGH, CRITICAL.',
    '- estimate: optional short effort string (e.g. "2d").',
    '- rationale: one sentence — why this item, and why that capability.',
    '',
    'Rules: items must be non-overlapping, right-sized (about half a day to 3 days each), and TOGETHER cover the whole goal.',
    `Produce at most ${maxItems} items.`,
    '',
    'Output STRICT JSON ONLY — no prose, no markdown fences:',
    '{"version":1,"items":[{"title":"…","description":"…","capabilityId":"…","priority":50,"urgency":"NORMAL","estimate":"2d","rationale":"…"}]}',
  ].join('\n')
}

function capabilityList(caps: AssignableCapability[]): string {
  return caps.map((c) => `- ${c.id}  ${c.name}`).join('\n')
}

function plannerTask(description: string, caps: AssignableCapability[], homeId: string): string {
  return [
    'GOAL:',
    description.trim(),
    '',
    'CAPABILITIES (assign each item to one of these ids):',
    capabilityList(caps),
    '',
    `HOME capability id: ${homeId}`,
  ].join('\n')
}

function criticPrompt(): string {
  return [
    'You are an INDEPENDENT reviewer of a work-item breakdown. You did NOT create it.',
    'Judge it against this rubric and report SPECIFIC issues (not a score):',
    '- completeness: parts of the GOAL covered by NO item.',
    '- faithfulness: items that introduce scope NOT in the GOAL (hallucinated work).',
    '- overlap: pairs of items that substantially overlap / duplicate each other.',
    '- sizing: items too large (should be split) or too trivial (should be merged).',
    '- assignment: items assigned to a capability that is a poor fit given its name.',
    '',
    'Output STRICT JSON ONLY:',
    '{"verdict":"pass|warn|fail","issues":[{"dimension":"completeness|faithfulness|overlap|sizing|assignment","itemRef":"<item title or index, or \'plan\'>","message":"…","fix":"…"}]}',
    'verdict: pass = no material issues; warn = minor; fail = misses major scope or is largely wrong.',
  ].join('\n')
}

function criticTask(description: string, items: PlannerItem[], caps: AssignableCapability[]): string {
  const capName = new Map(caps.map((c) => [c.id, c.name]))
  const rows = items.map((it, i) => ({
    i,
    title: it.title,
    description: it.description,
    capability: capName.get(it.capabilityId) ?? it.capabilityId,
  }))
  return [
    'GOAL:',
    description.trim(),
    '',
    'PROPOSED WORK ITEMS (JSON):',
    JSON.stringify(rows, null, 2),
  ].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Capability resolution
// ────────────────────────────────────────────────────────────────────────────

const CHILD_RELATIONSHIP = 'decomposes_to'

/** Home capability + (optionally) its non-governing `decomposes_to` children. */
export async function resolveAssignableCapabilities(
  homeId: string,
  allowChildren: boolean,
): Promise<AssignableCapability[]> {
  const home = await getCapability(homeId).catch(() => null)
  const list: AssignableCapability[] = [{ id: homeId, name: home?.name ?? 'Home capability' }]
  if (!allowChildren) return list
  const rels = await listCapabilityRelationships(homeId).catch(() => [])
  const childIds = [...new Set(rels.filter((r) => r.relationship_type === CHILD_RELATIONSHIP).map((r) => r.target_capability_id))]
  for (const id of childIds) {
    if (id === homeId) continue
    const cap = await getCapability(id).catch(() => null)
    if (cap?.isGoverning) continue // never delegate work into a governing capability
    list.push({ id, name: cap?.name ?? id })
  }
  return list
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────────────────────

export interface BreakdownInput {
  description: string
  capabilityId: string
  allowChildren?: boolean
  maxItems?: number
}

export interface BreakdownResult {
  items: PlannerItem[]
  assignableCapabilities: AssignableCapability[]
  homeCapabilityId: string
  deterministic: {
    repairedAssignments: number
    duplicatePairs: Array<{ a: number; b: number; score: number }>
    coverageGaps: string[]
  }
  critic: CriticResult
  usage: PlannerUsage
  parseError?: string
  raw?: string
}

export async function breakdownGoal(input: BreakdownInput, actorId: string): Promise<BreakdownResult> {
  const maxItems = Math.min(Math.max(input.maxItems ?? 12, 1), 40)
  const allowChildren = input.allowChildren !== false
  const caps = await resolveAssignableCapabilities(input.capabilityId, allowChildren)
  const allowed = new Set(caps.map((c) => c.id))
  const runCtx = { capability_id: input.capabilityId, user_id: actorId, surface: 'planner' }

  // 1) Planner — one re-ask on parse failure.
  const r1 = await contextFabricClient.executeGovernedTurn({
    trace_id: `planner:${input.capabilityId}`,
    run_context: runCtx,
    system_prompt: plannerPrompt(maxItems),
    task: plannerTask(input.description, caps, input.capabilityId),
    model_overrides: { temperature: 0.2, maxOutputTokens: 3000 },
    limits: { outputTokenBudget: 3000, timeoutSec: 120 },
  })
  const responses: Array<ExecuteResponse | null> = [r1]
  let parsed = parsePlannerPlan(r1.finalResponse)
  if (!parsed.ok) {
    const r1b = await contextFabricClient.executeGovernedTurn({
      trace_id: `planner:${input.capabilityId}:retry`,
      run_context: runCtx,
      system_prompt: plannerPrompt(maxItems),
      task:
        plannerTask(input.description, caps, input.capabilityId) +
        `\n\nYour previous answer FAILED validation: ${parsed.error}\nReturn STRICT JSON only, matching the schema exactly.`,
      model_overrides: { temperature: 0, maxOutputTokens: 3000 },
      limits: { outputTokenBudget: 3000, timeoutSec: 120 },
    })
    responses.push(r1b)
    parsed = parsePlannerPlan(r1b.finalResponse)
  }

  if (!parsed.ok) {
    return {
      items: [],
      assignableCapabilities: caps,
      homeCapabilityId: input.capabilityId,
      deterministic: { repairedAssignments: 0, duplicatePairs: [], coverageGaps: [] },
      critic: { verdict: 'fail', issues: [{ dimension: 'meta', itemRef: 'plan', message: 'Planner did not return valid JSON.' }] },
      usage: aggregateUsage(responses),
      parseError: parsed.error,
      raw: (responses[responses.length - 1]?.finalResponse ?? '').slice(0, 4000),
    }
  }

  // 2) Sanitize assignments (never trust model-supplied capability ids).
  const sanitized = sanitizeAssignments(parsed.items, allowed, input.capabilityId)

  // 3) Deterministic checks.
  const duplicatePairs = findDuplicatePairs(sanitized.items)
  const gaps = coverageGaps(input.description, sanitized.items)

  // 4) Independent critic (separate call; never blocks).
  let critic: CriticResult
  try {
    const rc = await contextFabricClient.executeGovernedTurn({
      trace_id: `planner-critic:${input.capabilityId}`,
      run_context: runCtx,
      system_prompt: criticPrompt(),
      task: criticTask(input.description, sanitized.items, caps),
      model_overrides: { temperature: 0, maxOutputTokens: 1500 },
      limits: { outputTokenBudget: 1500, timeoutSec: 90 },
    })
    responses.push(rc)
    critic = parseCritic(rc.finalResponse)
  } catch {
    critic = { verdict: 'warn', issues: [{ dimension: 'meta', itemRef: 'plan', message: 'Critic call failed; review the breakdown manually.' }] }
  }

  return {
    items: sanitized.items,
    assignableCapabilities: caps,
    homeCapabilityId: input.capabilityId,
    deterministic: { repairedAssignments: sanitized.repaired, duplicatePairs, coverageGaps: gaps },
    critic,
    usage: aggregateUsage(responses),
  }
}

export interface CommitInput {
  capabilityId: string
  items: PlannerItem[]
}

export async function commitBreakdown(input: CommitInput, actorId: string) {
  const home = input.capabilityId
  const results = await Promise.allSettled(
    input.items.map((it) =>
      createWorkItem(
        {
          title: it.title,
          description: it.description,
          parentCapabilityId: home,
          originType: it.capabilityId !== home ? 'PARENT_DELEGATED' : 'CAPABILITY_LOCAL',
          routingMode: 'MANUAL',
          urgency: it.urgency,
          priority: it.priority,
          details: { source: 'planner', title: it.title, description: it.description, rationale: it.rationale ?? null },
          targets: [{ targetCapabilityId: it.capabilityId }],
        },
        actorId,
      ),
    ),
  )

  const created: Array<{ id: string; workCode: string; capabilityId: string }> = []
  const failed: Array<{ title: string; error: string }> = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      created.push({ id: r.value.id, workCode: r.value.workCode, capabilityId: input.items[i].capabilityId })
    } else {
      failed.push({ title: input.items[i].title, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
    }
  })
  return { created, failed }
}
