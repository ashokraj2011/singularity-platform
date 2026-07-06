/**
 * Planner — a conversational, milestone-grouped roadmap planner.
 *
 * The user describes a goal; an agent (context-fabric, single-turn) either ASKS
 * clarifying questions (when the goal is vague) or produces/updates a
 * milestone-grouped roadmap of work items. The user can keep chatting to tweak
 * and regenerate. On commit, every task becomes a WorkItem in its capability's
 * inbox (home or a child capability).
 *
 * Ephemeral: the roadmap lives in the client session; nothing is persisted until
 * commit. Milestones are visual groupings (no cross-item dependencies yet).
 *
 * Pure helpers (extractJsonBlock, parseConverse, sanitizeMilestoneAssignments,
 * findDuplicatePairs, coverageGaps, flattenTasks, priorityToWorkItem, parseCritic,
 * aggregateUsage) are exported so they unit-test without the LLM or the DB.
 */
import { z } from 'zod'
import { traceIdFromParts } from '@workgraph/shared-types'
import { contextFabricClient, type ExecuteResponse } from '../../lib/context-fabric/client'
import { listCapabilityRelationships, getCapability } from '../../lib/iam/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { getSdlcIntent } from '../adoption/sdlcCatalog'
import { routeWorkItem } from '../work-items/work-item-routing.service'
import { createWorkItem } from '../work-items/work-items.service'
import { ValidationError } from '../../lib/errors'

export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type Priority = (typeof PRIORITIES)[number]

export const taskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  category: z.string().trim().max(40).catch('').default(''),
  capabilityId: z.string().trim().min(1),
  priority: z.enum(PRIORITIES).catch('MEDIUM').default('MEDIUM'),
  // Estimated effort in person-days (e.g. 0.5, 2, 5). Rolled up to a milestone total.
  effortDays: z.coerce.number().min(0).max(90).catch(1).default(1),
  aiSuggested: z.boolean().catch(false).default(false),
  rationale: z.string().trim().max(600).optional(),
})
export type PlannerTask = z.infer<typeof taskSchema>

export const milestoneSchema = z.object({
  id: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).catch('').default(''),
  tasks: z.array(taskSchema).default([]),
})
export type Milestone = z.infer<typeof milestoneSchema>

export const converseResponseSchema = z.object({
  reply: z.string().trim().catch('').default(''),
  needsClarification: z.boolean().catch(false).default(false),
  questions: z.array(z.string().trim().min(1)).catch([]).default([]),
  milestones: z.array(milestoneSchema).catch([]).default([]),
})

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

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
export function significantWords(s: string): string[] {
  return (String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Flatten the roadmap to a single task list (with their milestone index/title). */
export function flattenTasks(milestones: Milestone[]): Array<PlannerTask & { milestone: string; milestoneId: string }> {
  const out: Array<PlannerTask & { milestone: string; milestoneId: string }> = []
  for (const m of milestones ?? []) for (const t of m.tasks ?? []) out.push({ ...t, milestone: m.title, milestoneId: m.id })
  return out
}

/** Estimated effort (person-days) for one milestone — the sum of its tasks. */
export function milestoneEffortDays(m: Milestone): number {
  return Number((m.tasks ?? []).reduce((s, t) => s + (Number(t.effortDays) || 0), 0).toFixed(2))
}
/** Estimated effort (person-days) for the whole roadmap. */
export function totalEffortDays(milestones: Milestone[]): number {
  return Number((milestones ?? []).reduce((s, m) => s + milestoneEffortDays(m), 0).toFixed(2))
}

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

export function coverageGaps(goal: string, items: Array<{ title: string; description: string }>, max = 8): string[] {
  const covered = new Set<string>()
  for (const it of items) for (const w of significantWords(`${it.title} ${it.description}`)) covered.add(w)
  const gaps: string[] = []
  const seen = new Set<string>()
  for (const w of significantWords(goal)) {
    if (!covered.has(w) && !seen.has(w)) {
      seen.add(w)
      gaps.push(w)
    }
  }
  return gaps.slice(0, max)
}

/** Clamp every task's capabilityId across all milestones to the allowed set; else home. */
export function sanitizeMilestoneAssignments(
  milestones: Milestone[],
  allowedIds: Set<string>,
  homeId: string,
): { milestones: Milestone[]; repaired: number } {
  let repaired = 0
  const out = milestones.map((m) => ({
    ...m,
    tasks: m.tasks.map((t) => {
      if (allowedIds.has(t.capabilityId)) return t
      repaired++
      return { ...t, capabilityId: homeId }
    }),
  }))
  return { milestones: out, repaired }
}

export function parseConverse(
  raw: string,
): { ok: true; value: z.infer<typeof converseResponseSchema> } | { ok: false; error: string } {
  try {
    const json = JSON.parse(extractJsonBlock(raw))
    return { ok: true, value: converseResponseSchema.parse(json) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function parseCritic(raw: string): CriticResult {
  try {
    return criticSchema.parse(JSON.parse(extractJsonBlock(raw)))
  } catch {
    return { verdict: 'warn', issues: [{ dimension: 'meta', itemRef: 'plan', message: 'Critic output could not be parsed; review manually.' }] }
  }
}

/** Map the display priority to WorkItem urgency + numeric priority. */
export function priorityToWorkItem(p: Priority): { urgency: 'HIGH' | 'NORMAL' | 'LOW'; priority: number } {
  if (p === 'HIGH') return { urgency: 'HIGH', priority: 80 }
  if (p === 'LOW') return { urgency: 'LOW', priority: 30 }
  return { urgency: 'NORMAL', priority: 50 }
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

function plannerSystemPrompt(maxItems: number): string {
  return [
    'You are a product planning agent. You turn a goal into a MILESTONE-GROUPED roadmap of work items, and you converse to refine it.',
    'You are given the CONVERSATION so far, the CURRENT ROADMAP (may be empty), and a list of CAPABILITIES (id + name; the first is HOME).',
    '',
    'Decide each turn:',
    '- If the goal is too vague to plan well, ASK 2–4 specific clarifying questions instead of guessing: set needsClarification=true, fill "questions", and leave "milestones" empty.',
    '- Otherwise produce or UPDATE the roadmap. Apply the user\'s latest instruction (e.g. "split milestone 2", "add a fraud task", "reassign X to the data team"). PRESERVE the parts of the current roadmap the user did not ask to change.',
    '',
    'Roadmap shape: 1–6 milestones, each 1–8 tasks. Each task has:',
    '- title (imperative), description (acceptance-oriented),',
    '- category: ONE short UPPERCASE label (e.g. DATABASE, SECURITY, API, UI, INFRA, PAYMENTS),',
    '- capabilityId: the best-fit id from the list — NEVER invent an id; use HOME if unsure,',
    '- priority: HIGH | MEDIUM | LOW,',
    '- effortDays: estimated effort in PERSON-DAYS as a number (e.g. 0.5, 1, 2, 5) — be realistic; a milestone\'s effort is the sum of its tasks,',
    '- aiSuggested: true if YOU proposed it without the user explicitly asking,',
    '- rationale: one sentence.',
    `Keep the whole roadmap to at most ${maxItems} tasks.`,
    '',
    'Always include a short "reply" (1–3 sentences): what you did, or your questions.',
    '',
    'Output STRICT JSON ONLY — no prose, no markdown fences:',
    '{"reply":"…","needsClarification":false,"questions":[],"milestones":[{"id":"M1","title":"Foundation","summary":"…","tasks":[{"title":"…","description":"…","category":"DATABASE","capabilityId":"…","priority":"HIGH","effortDays":2,"aiSuggested":false,"rationale":"…"}]}]}',
  ].join('\n')
}

function capabilityList(caps: AssignableCapability[]): string {
  return caps.map((c) => `- ${c.id}  ${c.name}`).join('\n')
}

function transcript(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n')
}

function converseTask(
  messages: ChatMessage[],
  plan: Milestone[],
  caps: AssignableCapability[],
  homeId: string,
): string {
  return [
    'CAPABILITIES (assign tasks by id):',
    capabilityList(caps),
    `HOME capability id: ${homeId}`,
    '',
    'CURRENT ROADMAP (JSON):',
    plan.length ? JSON.stringify({ milestones: plan }, null, 2) : '(none yet)',
    '',
    'CONVERSATION:',
    transcript(messages),
    '',
    'Respond with the JSON object only.',
  ].join('\n')
}

function criticPrompt(): string {
  return [
    'You are an INDEPENDENT reviewer of a milestone-grouped work-item roadmap. You did NOT create it.',
    'Judge it against this rubric and report SPECIFIC issues (not a score):',
    '- completeness: parts of the GOAL covered by NO task.',
    '- faithfulness: tasks that introduce scope NOT in the GOAL.',
    '- overlap: tasks that substantially duplicate each other.',
    '- sizing: tasks too large (split) or too trivial (merge); milestones poorly grouped.',
    '- assignment: tasks assigned to a capability that is a poor fit.',
    '',
    'Output STRICT JSON ONLY:',
    '{"verdict":"pass|warn|fail","issues":[{"dimension":"…","itemRef":"<task title or \'plan\'>","message":"…","fix":"…"}]}',
  ].join('\n')
}

function criticTask(goal: string, milestones: Milestone[], caps: AssignableCapability[]): string {
  const capName = new Map(caps.map((c) => [c.id, c.name]))
  const rows = milestones.map((m) => ({
    milestone: m.title,
    tasks: m.tasks.map((t) => ({ title: t.title, description: t.description, capability: capName.get(t.capabilityId) ?? t.capabilityId })),
  }))
  return ['GOAL:', goal.trim(), '', 'ROADMAP (JSON):', JSON.stringify(rows, null, 2)].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Capability resolution
// ────────────────────────────────────────────────────────────────────────────

const CHILD_RELATIONSHIP = 'decomposes_to'

function capabilityStatus(capability: Awaited<ReturnType<typeof getCapability>>): string {
  return String(capability?.status ?? 'ACTIVE').trim().toUpperCase()
}

async function assertPlannerCapabilityActive(capabilityId: string): Promise<AssignableCapability> {
  const capability = await getCapability(capabilityId)
  if (!capability) throw new ValidationError(`Capability ${capabilityId} is not available to the planner.`)
  const status = capabilityStatus(capability)
  if (status !== 'ACTIVE') {
    throw new ValidationError(`Capability ${capabilityId} is ${status}; planner converse, commit, and launch require an ACTIVE capability.`)
  }
  return { id: capabilityId, name: capability.name ?? 'Home capability' }
}

async function assertPlannerAssignmentsActive(homeId: string, milestones: Milestone[]): Promise<void> {
  const caps = await resolveAssignableCapabilities(homeId, true)
  const allowed = new Set(caps.map((capability) => capability.id))
  const invalid = flattenTasks(milestones).filter((task) => !allowed.has(task.capabilityId))
  if (invalid.length > 0) {
    const labels = invalid.slice(0, 5).map((task) => `${task.title} → ${task.capabilityId}`).join('; ')
    throw new ValidationError(`Planner roadmap includes task assignments outside the active capability scope: ${labels}`)
  }
}

async function assertPlannerWorkflowTemplateLaunchable(
  homeId: string,
  milestones: Milestone[],
  workflowTemplateId?: string | null,
): Promise<void> {
  if (!workflowTemplateId) return
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowTemplateId },
    select: {
      id: true,
      name: true,
      capabilityId: true,
      archivedAt: true,
      status: true,
      profile: true,
    },
  })
  if (!workflow || workflow.archivedAt || String(workflow.status ?? '').trim().toUpperCase() === 'ARCHIVED') {
    throw new ValidationError(`Workflow template ${workflowTemplateId} is not available for planner launch.`)
  }
  if (String(workflow.profile ?? 'main').trim().toLowerCase() === 'workbench') {
    throw new ValidationError(
      `"${workflow.name}" is a workbench-profile template; planner launch requires a main workflow template. ` +
      `Use a main workflow with a CALL_WORKFLOW node to invoke this workbench.`,
    )
  }

  await assertPlannerAssignmentsActive(homeId, milestones)
  const targetCapabilityIds = new Set(flattenTasks(milestones).map((task) => task.capabilityId))
  if (!workflow.capabilityId || !targetCapabilityIds.has(workflow.capabilityId)) {
    const targets = [...targetCapabilityIds].join(', ')
    throw new ValidationError(
      `Workflow template ${workflowTemplateId} belongs to capability ${workflow.capabilityId ?? 'none'}, ` +
      `but this planner launch targets ${targets || homeId}.`,
    )
  }
}

export async function resolveAssignableCapabilities(homeId: string, allowChildren: boolean): Promise<AssignableCapability[]> {
  const home = await assertPlannerCapabilityActive(homeId)
  const list: AssignableCapability[] = [home]
  if (!allowChildren) return list
  const rels = await listCapabilityRelationships(homeId).catch(() => [])
  const childIds = [...new Set(rels.filter((r) => r.relationship_type === CHILD_RELATIONSHIP).map((r) => r.target_capability_id))]
  for (const id of childIds) {
    if (id === homeId) continue
    const cap = await getCapability(id).catch(() => null)
    if (!cap || cap.isGoverning || capabilityStatus(cap) !== 'ACTIVE') continue
    list.push({ id, name: cap.name ?? id })
  }
  return list
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────────────────────

export interface ConverseInput {
  capabilityId: string
  messages: ChatMessage[]
  plan?: Milestone[]
  allowChildren?: boolean
  maxItems?: number
}

export interface ConverseResult {
  reply: string
  needsClarification: boolean
  questions: string[]
  milestones: Milestone[]
  assignableCapabilities: AssignableCapability[]
  homeCapabilityId: string
  deterministic: { repairedAssignments: number; duplicatePairs: Array<{ a: number; b: number; score: number }>; coverageGaps: string[] }
  critic: CriticResult | null
  usage: PlannerUsage
  parseError?: string
  raw?: string
}

export async function converse(input: ConverseInput, actorId: string): Promise<ConverseResult> {
  const maxItems = Math.min(Math.max(input.maxItems ?? 16, 1), 40)
  const allowChildren = input.allowChildren !== false
  const caps = await resolveAssignableCapabilities(input.capabilityId, allowChildren)
  const allowed = new Set(caps.map((c) => c.id))
  const home = input.capabilityId
  const runCtx = { capability_id: home, user_id: actorId, surface: 'planner' }
  const goal = input.messages.find((m) => m.role === 'user')?.content ?? ''
  const currentPlan = input.plan ?? []

  const plannerTraceId = traceIdFromParts(['planner', home], ':')
  const base = {
    trace_id: plannerTraceId,
    run_context: runCtx,
    system_prompt: plannerSystemPrompt(maxItems),
    model_overrides: { temperature: 0.3, maxOutputTokens: 3500 },
    limits: { outputTokenBudget: 3500, timeoutSec: 150 },
  }

  // 1) Planner / chat turn — one re-ask on parse failure.
  const r1 = await contextFabricClient.executeGovernedTurn({ ...base, task: converseTask(input.messages, currentPlan, caps, home) })
  const responses: Array<ExecuteResponse | null> = [r1]
  let parsed = parseConverse(r1.finalResponse)
  if (!parsed.ok) {
    const r1b = await contextFabricClient.executeGovernedTurn({
      ...base,
      model_overrides: { temperature: 0, maxOutputTokens: 3500 },
      task: converseTask(input.messages, currentPlan, caps, home) + `\n\nYour previous answer FAILED validation: ${parsed.error}\nReturn STRICT JSON only.`,
    })
    responses.push(r1b)
    parsed = parseConverse(r1b.finalResponse)
  }

  if (!parsed.ok) {
    return {
      reply: "I couldn't produce a valid plan — try rephrasing.",
      needsClarification: false,
      questions: [],
      milestones: [],
      assignableCapabilities: caps,
      homeCapabilityId: home,
      deterministic: { repairedAssignments: 0, duplicatePairs: [], coverageGaps: [] },
      critic: null,
      usage: aggregateUsage(responses),
      parseError: parsed.error,
      raw: (responses[responses.length - 1]?.finalResponse ?? '').slice(0, 4000),
    }
  }

  const value = parsed.value

  // Clarification turn — no plan, no critic.
  if (value.needsClarification || value.milestones.length === 0) {
    return {
      reply: value.reply || (value.questions.length ? 'A few questions before I plan:' : 'Tell me a bit more.'),
      needsClarification: value.questions.length > 0,
      questions: value.questions,
      milestones: [],
      assignableCapabilities: caps,
      homeCapabilityId: home,
      deterministic: { repairedAssignments: 0, duplicatePairs: [], coverageGaps: [] },
      critic: null,
      usage: aggregateUsage(responses),
    }
  }

  // 2) Sanitize assignments (never trust model-supplied capability ids).
  const sanitized = sanitizeMilestoneAssignments(value.milestones, allowed, home)
  const flat = flattenTasks(sanitized.milestones)

  // 3) Deterministic checks.
  const duplicatePairs = findDuplicatePairs(flat)
  const gaps = coverageGaps(goal, flat)

  // 4) Independent critic (separate call; best-effort).
  let critic: CriticResult | null = null
  try {
    const rc = await contextFabricClient.executeGovernedTurn({
      trace_id: traceIdFromParts(['planner-critic', home], ':'),
      run_context: runCtx,
      system_prompt: criticPrompt(),
      task: criticTask(goal, sanitized.milestones, caps),
      model_overrides: { temperature: 0, maxOutputTokens: 1500 },
      limits: { outputTokenBudget: 1500, timeoutSec: 90 },
    })
    responses.push(rc)
    critic = parseCritic(rc.finalResponse)
  } catch {
    critic = { verdict: 'warn', issues: [{ dimension: 'meta', itemRef: 'plan', message: 'Critic call failed; review the roadmap manually.' }] }
  }

  return {
    reply: value.reply || 'Here is the roadmap.',
    needsClarification: false,
    questions: [],
    milestones: sanitized.milestones,
    assignableCapabilities: caps,
    homeCapabilityId: home,
    deterministic: { repairedAssignments: sanitized.repaired, duplicatePairs, coverageGaps: gaps },
    critic,
    usage: aggregateUsage(responses),
  }
}

export interface CommitInput {
  capabilityId: string
  milestones: Milestone[]
}

export async function commitRoadmap(input: CommitInput, actorId: string) {
  const home = input.capabilityId
  await assertPlannerAssignmentsActive(home, input.milestones)
  const tasks = flattenTasks(input.milestones)
  const results = await Promise.allSettled(
    tasks.map((t) => {
      const { urgency, priority } = priorityToWorkItem(t.priority)
      return createWorkItem(
        {
          title: t.title,
          description: t.description,
          parentCapabilityId: home,
          originType: t.capabilityId !== home ? 'PARENT_DELEGATED' : 'CAPABILITY_LOCAL',
          routingMode: 'MANUAL',
          urgency,
          priority,
          details: {
            source: 'planner',
            milestone: t.milestone,
            category: t.category || null,
            effortDays: t.effortDays ?? null,
            rationale: t.rationale ?? null,
            title: t.title,
            description: t.description,
          },
          targets: [{ targetCapabilityId: t.capabilityId }],
        },
        actorId,
      )
    }),
  )

  const created: Array<{ id: string; workCode: string; capabilityId: string; milestone: string }> = []
  const failed: Array<{ title: string; error: string }> = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      created.push({ id: r.value.id, workCode: r.value.workCode, capabilityId: tasks[i].capabilityId, milestone: tasks[i].milestone })
    } else {
      failed.push({ title: tasks[i].title, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
    }
  })
  return { created, failed }
}

export interface LaunchInput {
  capabilityId: string
  intent?: string
  story?: string
  plan?: Milestone[]
  milestones?: Milestone[]
  workflowTemplateId?: string
  modelAlias?: string
  runtimePreference?: string
  governancePreset?: string
}

type LaunchTarget = {
  childWorkflowTemplateId?: string | null
  childWorkflowInstanceId?: string | null
}

function compactText(value: string, max = 140): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function localLaunchMilestones(story: string, capabilityId: string): Milestone[] {
  const base = compactText(story || 'Deliver the requested SDLC change.', 220)
  const tasks: PlannerTask[] = [
    {
      title: 'Clarify acceptance criteria',
      description: `Confirm the delivery outcome, constraints, and definition of done for: ${base}`,
      category: 'INTAKE',
      capabilityId,
      priority: 'HIGH',
      effortDays: 1,
      aiSuggested: true,
      rationale: 'Created as a deterministic fallback when no planner roadmap was supplied.',
    },
    {
      title: 'Design governed workflow path',
      description: 'Select the workflow template, required agents, runtime preference, and evidence gates for the story.',
      category: 'DESIGN',
      capabilityId,
      priority: 'HIGH',
      effortDays: 1,
      aiSuggested: true,
      rationale: 'Ensures the launch has a traceable workflow intent.',
    },
    {
      title: 'Implement and verify the change',
      description: 'Run the implementation workflow, capture code changes, tests, receipts, and runtime activity.',
      category: 'BUILD',
      capabilityId,
      priority: 'MEDIUM',
      effortDays: 2,
      aiSuggested: true,
      rationale: 'Covers the core SDLC execution path.',
    },
    {
      title: 'Publish delivery evidence pack',
      description: 'Collect decisions, artifacts, test results, approvals, cost/model summary, and Copilot handoff outputs.',
      category: 'EVIDENCE',
      capabilityId,
      priority: 'MEDIUM',
      effortDays: 1,
      aiSuggested: true,
      rationale: 'Makes the run adoption-ready for review.',
    },
  ]
  return [{
    id: 'M1',
    title: 'Guided SDLC launch',
    summary: 'Deterministic launch plan generated from the submitted story.',
    tasks,
  }]
}

function firstStartedTarget(value: unknown): LaunchTarget | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const targets = Array.isArray(record.targets) ? record.targets : []
  for (const item of targets) {
    const target = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const childWorkflowInstanceId = typeof target.childWorkflowInstanceId === 'string' ? target.childWorkflowInstanceId : null
    const childWorkflowTemplateId = typeof target.childWorkflowTemplateId === 'string' ? target.childWorkflowTemplateId : null
    if (childWorkflowInstanceId || childWorkflowTemplateId) return { childWorkflowInstanceId, childWorkflowTemplateId }
  }
  return null
}

async function summarizeWorkflowTemplate(id?: string | null) {
  if (!id) return null
  return prisma.workflow.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      capabilityId: true,
      workflowTypeKey: true,
      profile: true,
      defaultRoutingMode: true,
      metadata: true,
    },
  })
}

async function summarizeWorkflowInstance(id?: string | null) {
  if (!id) return null
  // Request-scoped (planner.router) — tenantId defaults to the request tenant via ALS.
  return withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      templateId: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  }))
}

export async function launchRoadmap(input: LaunchInput, actorId: string) {
  const intent = getSdlcIntent(input.intent)
  const milestones = input.plan?.length
    ? input.plan
    : input.milestones?.length
      ? input.milestones
      : localLaunchMilestones(input.story ?? '', input.capabilityId)
  await assertPlannerWorkflowTemplateLaunchable(input.capabilityId, milestones, input.workflowTemplateId)
  const commit = await commitRoadmap({ capabilityId: input.capabilityId, milestones }, actorId)
  const warnings: string[] = []
  let routedWorkItem: unknown = null
  let launchTarget: LaunchTarget | null = null

  if (commit.created.length === 0) {
    warnings.push('No WorkItems were created, so workflow launch was skipped.')
  } else {
    for (const created of commit.created) {
      try {
        const routed = await routeWorkItem(created.id, actorId, {
          workflowId: input.workflowTemplateId,
          workflowTypeKey: intent.workflowTypeKeys[0],
          routingMode: 'AUTO_START',
          startNow: true,
        })
        const target = firstStartedTarget(routed)
        if (target?.childWorkflowInstanceId) {
          routedWorkItem = routed
          launchTarget = target
          break
        }
        if (!launchTarget && target) {
          routedWorkItem = routed
          launchTarget = target
        }
      } catch (err) {
        warnings.push(`Launch attempt for ${created.workCode} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!launchTarget?.childWorkflowInstanceId) {
      warnings.push('Created WorkItems, but no eligible workflow run was started. Attach/start a seeded workflow from the WorkItems inbox.')
    }
  }

  const workflowTemplate = await summarizeWorkflowTemplate(
    launchTarget?.childWorkflowTemplateId ?? input.workflowTemplateId ?? null,
  )
  const workflowInstance = await summarizeWorkflowInstance(launchTarget?.childWorkflowInstanceId ?? null)

  return {
    intent,
    workItems: commit.created,
    failedWorkItems: commit.failed,
    workflowTemplate,
    workflowInstance,
    runUrl: workflowInstance?.id ? `/runs/${workflowInstance.id}` : null,
    workItemsUrl: '/work-items',
    routedWorkItem,
    runtime: {
      modelAlias: input.modelAlias ?? intent.defaultModelAlias,
      runtimePreference: input.runtimePreference ?? intent.runtimePreference,
      governancePreset: input.governancePreset ?? intent.governancePreset,
    },
    warnings,
  }
}
