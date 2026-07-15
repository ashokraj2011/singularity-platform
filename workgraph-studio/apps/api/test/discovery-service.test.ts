/**
 * Unit tests for the unified Discovery service (ADR 0006). Drives the full
 * elicit loop with in-memory fakes for the store/model/tool ports — no live
 * DB, Context Fabric, or MCP required. Covers: the gate (blocking/gating),
 * elicit persistence + dedupe, budget caps, answer-unblocks, and the pure
 * parser.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createDiscoveryService,
  computeSessionStatus,
  parseElicitation,
  mergeBudget,
  budgetExhausted,
} from '../src/modules/discovery/discovery.service'
import { createDiscoveryBridge } from '../src/modules/discovery/discovery.bridge'
import { DEFAULT_BUDGET } from '../src/modules/discovery/discovery.types'
import type {
  DiscoveryAssumptionRecord,
  DiscoveryBudget,
  DiscoveryQuestionRecord,
  DiscoverySessionWithChildren,
  DiscoveryStore,
  ModelCaller,
  ToolCaller,
} from '../src/modules/discovery/discovery.types'

// ── In-memory store fake ─────────────────────────────────────────────────────

function makeStore(): DiscoveryStore & { _sessions: Map<string, DiscoverySessionWithChildren> } {
  const sessions = new Map<string, DiscoverySessionWithChildren>()
  let seq = 0
  const id = (p: string) => `${p}-${++seq}`
  const now = () => new Date('2026-07-15T00:00:00Z')

  return {
    _sessions: sessions,
    async createSession(input) {
      const s: DiscoverySessionWithChildren = {
        id: id('sess'),
        tenantId: input.tenantId ?? 'default',
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        status: 'OPEN',
        touchPoint: input.touchPoint ?? 'DISCOVERY',
        budget: input.budget ? mergeBudget(null, input.budget) : null,
        createdById: input.createdById ?? null,
        createdAt: now(),
        updatedAt: now(),
        questions: [],
        assumptions: [],
      }
      sessions.set(s.id, s)
      return s
    },
    async getSession(sid) {
      const s = sessions.get(sid)
      return s ? { ...s, questions: [...s.questions], assumptions: [...s.assumptions] } : null
    },
    async findSessionByScope(scopeType, scopeId, tenantId) {
      for (const s of sessions.values()) {
        if (s.scopeType === scopeType && s.scopeId === scopeId && (!tenantId || s.tenantId === tenantId)) return s
      }
      return null
    },
    async updateSessionStatus(sid, status) {
      const s = sessions.get(sid)
      if (s) s.status = status
    },
    async updateSessionBudget(sid, budget) {
      const s = sessions.get(sid)
      if (s) s.budget = budget
    },
    async addQuestion(input) {
      const s = sessions.get(input.sessionId)!
      const q: DiscoveryQuestionRecord = {
        id: id('q'),
        sessionId: input.sessionId,
        tenantId: input.tenantId ?? 'default',
        text: input.text,
        kind: input.kind ?? 'clarification',
        source: input.source ?? 'human',
        blocking: input.blocking ?? false,
        status: 'OPEN',
        options: input.options,
        answer: null,
        proposedAnswer: input.proposedAnswer ?? null,
        confidence: input.confidence ?? null,
        ordinal: input.ordinal ?? s.questions.length,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        createdAt: now(),
        updatedAt: now(),
      }
      s.questions.push(q)
      return q
    },
    async findQuestionByText(sid, text) {
      const s = sessions.get(sid)
      return s?.questions.find(q => q.text === text.trim()) ?? null
    },
    async findQuestionBySource(sourceType, sourceId) {
      for (const s of sessions.values()) {
        const q = s.questions.find(x => x.sourceType === sourceType && x.sourceId === sourceId)
        if (q) return q
      }
      return null
    },
    async getQuestion(qid) {
      for (const s of sessions.values()) {
        const q = s.questions.find(x => x.id === qid)
        if (q) return q
      }
      return null
    },
    async answerQuestion(qid, answer, answeredById) {
      for (const s of sessions.values()) {
        const q = s.questions.find(x => x.id === qid)
        if (q) {
          q.status = 'ANSWERED'
          q.answer = answer
          q.answeredById = answeredById ?? null
          q.answeredAt = now()
          return q
        }
      }
      throw new Error('not found')
    },
    async dismissQuestion(qid) {
      for (const s of sessions.values()) {
        const q = s.questions.find(x => x.id === qid)
        if (q) {
          q.status = 'DISMISSED'
          return q
        }
      }
      throw new Error('not found')
    },
    async addAssumption(input) {
      const s = sessions.get(input.sessionId)!
      const a: DiscoveryAssumptionRecord = {
        id: id('a'),
        sessionId: input.sessionId,
        tenantId: input.tenantId ?? 'default',
        text: input.text,
        confidence: input.confidence ?? 0.5,
        status: 'PROPOSED',
        evidenceRef: input.evidenceRef,
        createdAt: now(),
        updatedAt: now(),
      }
      s.assumptions.push(a)
      return a
    },
    async getAssumption(aid) {
      for (const s of sessions.values()) {
        const a = s.assumptions.find(x => x.id === aid)
        if (a) return a
      }
      return null
    },
    async setAssumptionStatus(aid, status, opts) {
      for (const s of sessions.values()) {
        const a = s.assumptions.find(x => x.id === aid)
        if (a) {
          a.status = status
          a.validatedById = opts?.validatedById ?? null
          a.evidenceRef = opts?.evidenceRef ?? a.evidenceRef
          return a
        }
      }
      throw new Error('not found')
    },
  }
}

function makeService(overrides?: { model?: ModelCaller; tool?: ToolCaller; alias?: string | null }) {
  const store = makeStore()
  const model: ModelCaller = overrides?.model ?? {
    governedTurn: vi.fn(async () => ({ status: 'COMPLETED', text: '{"questions":[],"assumptions":[]}', inputTokens: 10, outputTokens: 5 })),
  }
  const tool: ToolCaller = overrides?.tool ?? { run: vi.fn(async () => ({ ok: true, data: 'finding' })) }
  const resolveRouting = vi.fn(async () => overrides?.alias ?? null)
  const svc = createDiscoveryService({ store, model, tool, resolveRouting })
  return { svc, store, model, tool, resolveRouting }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('computeSessionStatus', () => {
  it('is BLOCKED when a blocking question is OPEN', () => {
    expect(computeSessionStatus('OPEN', [{ blocking: true, status: 'OPEN' }])).toBe('BLOCKED')
  })
  it('is OPEN when only non-blocking questions remain open', () => {
    expect(computeSessionStatus('OPEN', [{ blocking: false, status: 'OPEN' }])).toBe('OPEN')
  })
  it('is RESOLVED when nothing is open', () => {
    expect(computeSessionStatus('BLOCKED', [{ blocking: true, status: 'ANSWERED' }])).toBe('RESOLVED')
    expect(computeSessionStatus('OPEN', [])).toBe('RESOLVED')
  })
  it('keeps ABANDONED terminal', () => {
    expect(computeSessionStatus('ABANDONED', [{ blocking: true, status: 'OPEN' }])).toBe('ABANDONED')
  })
  it('ignores dismissed questions for gating', () => {
    expect(computeSessionStatus('BLOCKED', [{ blocking: true, status: 'DISMISSED' }])).toBe('RESOLVED')
  })
})

describe('parseElicitation', () => {
  it('parses a bare JSON object', () => {
    const r = parseElicitation('{"questions":[{"text":"Which DB?","blocking":true}],"assumptions":[{"text":"pg","confidence":0.7}]}')
    expect(r?.questions[0].text).toBe('Which DB?')
    expect(r?.questions[0].blocking).toBe(true)
    expect(r?.assumptions[0].confidence).toBe(0.7)
  })
  it('parses a fenced ```json block', () => {
    const r = parseElicitation('sure!\n```json\n{"questions":[{"text":"X"}],"assumptions":[]}\n```')
    expect(r?.questions).toHaveLength(1)
  })
  it('clamps confidence to 0..1 and drops textless entries', () => {
    const r = parseElicitation('{"questions":[{"text":"","confidence":5},{"text":"ok","confidence":9}],"assumptions":[]}')
    expect(r?.questions).toHaveLength(1)
    expect(r?.questions[0].confidence).toBe(1)
  })
  it('returns null for empty text', () => {
    expect(parseElicitation('')).toBeNull()
  })
})

describe('budget helpers', () => {
  it('merges defaults + persisted + override', () => {
    const b = mergeBudget({ ...DEFAULT_BUDGET, turns: 3 }, { maxTurns: 2 })
    expect(b.turns).toBe(3)
    expect(b.maxTurns).toBe(2)
  })
  it('flags exhaustion per dimension', () => {
    const b: DiscoveryBudget = { ...DEFAULT_BUDGET, maxTurns: 1, turns: 1, maxToolCalls: 0 }
    const e = budgetExhausted(b)
    expect(e.turns).toBe(true)
    expect(e.tools).toBe(true)
    expect(e.tokens).toBe(false)
  })
})

// ── Elicit loop ──────────────────────────────────────────────────────────────

describe('elicit', () => {
  it('persists model-proposed questions + assumptions and gates the session', async () => {
    const model: ModelCaller = {
      governedTurn: vi.fn(async () => ({
        status: 'COMPLETED',
        text: '{"questions":[{"text":"Which cloud?","blocking":true}],"assumptions":[{"text":"AWS","confidence":0.6}]}',
        inputTokens: 100,
        outputTokens: 50,
      })),
    }
    const { svc, store } = makeService({ model })
    const s = await svc.createSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-1' })
    const res = await svc.elicit({ sessionId: s.id })

    expect(res.addedQuestions).toHaveLength(1)
    expect(res.addedQuestions[0].source).toBe('llm')
    expect(res.addedAssumptions).toHaveLength(1)
    expect(res.session.status).toBe('BLOCKED')
    expect(store._sessions.get(s.id)!.budget!.turns).toBe(1)
    expect(store._sessions.get(s.id)!.budget!.inputTokens).toBe(100)
  })

  it('dedupes questions by text across iterations', async () => {
    const model: ModelCaller = {
      governedTurn: vi.fn(async () => ({
        status: 'COMPLETED',
        text: '{"questions":[{"text":"Same Q?"}],"assumptions":[]}',
        inputTokens: 1,
        outputTokens: 1,
      })),
    }
    const { svc } = makeService({ model })
    const s = await svc.createSession({ scopeType: 'RUN', scopeId: 'r-1' })
    const first = await svc.elicit({ sessionId: s.id })
    const second = await svc.elicit({ sessionId: s.id })
    expect(first.addedQuestions).toHaveLength(1)
    expect(second.addedQuestions).toHaveLength(0)
    expect(second.session.questions).toHaveLength(1)
  })

  it('skips elicitation when the turn budget is exhausted', async () => {
    const model: ModelCaller = { governedTurn: vi.fn(async () => ({ status: 'COMPLETED', text: '{}', inputTokens: 0, outputTokens: 0 })) }
    const { svc } = makeService({ model })
    const s = await svc.createSession({ scopeType: 'RUN', scopeId: 'r-2', budget: { maxTurns: 1 } })
    await svc.elicit({ sessionId: s.id })
    const res = await svc.elicit({ sessionId: s.id })
    expect(res.notes.some(n => /budget exhausted/i.test(n))).toBe(true)
    expect(model.governedTurn).toHaveBeenCalledTimes(1)
  })

  it('runs the research tool before eliciting and counts it against budget', async () => {
    const tool: ToolCaller = { run: vi.fn(async () => ({ ok: true, data: 'repo uses postgres' })) }
    const { svc, store } = makeService({ tool })
    const s = await svc.createSession({ scopeType: 'WORKFLOW_STAGE', scopeId: 'stg-1' })
    await svc.elicit({ sessionId: s.id, research: { toolName: 'grep', args: { q: 'db' } } })
    expect(tool.run).toHaveBeenCalledOnce()
    expect(store._sessions.get(s.id)!.budget!.toolCalls).toBe(1)
  })

  it('routes to Copilot executor when the resolved alias matches', async () => {
    const model: ModelCaller = { governedTurn: vi.fn(async () => ({ status: 'COMPLETED', text: '{"questions":[{"text":"Q"}],"assumptions":[]}', inputTokens: 1, outputTokens: 1 })) }
    const { svc } = makeService({ model, alias: 'gh-copilot-gpt' })
    const s = await svc.createSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-2' })
    const res = await svc.elicit({ sessionId: s.id })
    expect((model.governedTurn as any).mock.calls[0][0].executor).toBe('copilot')
    expect(res.addedQuestions[0].source).toBe('copilot')
  })

  it('degrades gracefully when the model turn throws', async () => {
    const model: ModelCaller = { governedTurn: vi.fn(async () => { throw new Error('CF down') }) }
    const { svc } = makeService({ model })
    const s = await svc.createSession({ scopeType: 'RUN', scopeId: 'r-3' })
    const res = await svc.elicit({ sessionId: s.id })
    expect(res.addedQuestions).toHaveLength(0)
    expect(res.notes.some(n => /Model turn failed/.test(n))).toBe(true)
  })
})

describe('answer / dismiss unblocks the gate', () => {
  it('BLOCKED → RESOLVED once the blocking question is answered', async () => {
    const { svc } = makeService()
    const s = await svc.createSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-3' })
    const q = await svc.addQuestion({ sessionId: s.id, text: 'Need approval?', blocking: true })
    let session = await svc.getSession(s.id)
    expect(session!.status).toBe('BLOCKED')
    await svc.answerQuestion(q.id, 'yes', 'user-1')
    session = await svc.getSession(s.id)
    expect(session!.status).toBe('RESOLVED')
  })

  it('dismissing the last blocking question also unblocks', async () => {
    const { svc } = makeService()
    const s = await svc.createSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-4' })
    const q = await svc.addQuestion({ sessionId: s.id, text: 'Optional?', blocking: true })
    await svc.dismissQuestion(q.id)
    const session = await svc.getSession(s.id)
    expect(session!.status).toBe('RESOLVED')
  })
})

describe('resolveSession — get-or-create by scope (Slice 3 UI)', () => {
  it('creates on first call and returns the same session (with children) after', async () => {
    const { svc } = makeService()
    const first = await svc.resolveSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-r1' })
    expect(first.questions).toEqual([])
    expect(first.assumptions).toEqual([])
    await svc.addQuestion({ sessionId: first.id, text: 'Region?', blocking: true })
    const second = await svc.resolveSession({ scopeType: 'WORK_ITEM', scopeId: 'wi-r1' })
    expect(second.id).toBe(first.id)
    expect(second.questions).toHaveLength(1)
    expect(second.status).toBe('BLOCKED')
  })
})

// ── Compatibility bridge (Slice 2) ───────────────────────────────────────────

describe('discovery bridge — work-item clarifications', () => {
  it('mirrors a clarification as a blocking question on the WI session (get-or-create)', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    const q = await bridge.mirrorClarificationRequested({
      workItemId: 'wi-100',
      clarificationId: 'clar-1',
      question: 'Which region?',
    })
    expect(q?.blocking).toBe(true)
    expect(q?.sourceType).toBe('work_item_clarification')
    const session = await store.findSessionByScope('WORK_ITEM', 'wi-100')
    const full = await store.getSession(session!.id)
    expect(full!.status).toBe('BLOCKED')
  })

  it('is idempotent — a repeated request does not duplicate the question', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    await bridge.mirrorClarificationRequested({ workItemId: 'wi-101', clarificationId: 'clar-2', question: 'Q?' })
    await bridge.mirrorClarificationRequested({ workItemId: 'wi-101', clarificationId: 'clar-2', question: 'Q?' })
    const session = await store.findSessionByScope('WORK_ITEM', 'wi-101')
    const full = await store.getSession(session!.id)
    expect(full!.questions).toHaveLength(1)
  })

  it('mirroring an answer unblocks the session', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    await bridge.mirrorClarificationRequested({ workItemId: 'wi-102', clarificationId: 'clar-3', question: 'Q?' })
    const updated = await bridge.mirrorClarificationAnswered({ clarificationId: 'clar-3', answer: 'yes', answeredById: 'u1' })
    expect(updated?.status).toBe('ANSWERED')
    const session = await store.findSessionByScope('WORK_ITEM', 'wi-102')
    const full = await store.getSession(session!.id)
    expect(full!.status).toBe('RESOLVED')
  })

  it('answering an unknown clarification is a no-op', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    const r = await bridge.mirrorClarificationAnswered({ clarificationId: 'nope', answer: 'x' })
    expect(r).toBeNull()
  })
})

describe('discovery bridge — workbench stage questions', () => {
  it('seeds configured questions with required→blocking, idempotently', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    const first = await bridge.seedStageQuestions({
      stageId: 'stg-9',
      questions: [
        { questionId: 'q1', text: 'Target platform?', required: true },
        { questionId: 'q2', text: 'Nice to have?', required: false },
      ],
    })
    expect(first.seeded).toHaveLength(2)
    const blocking = first.seeded.find(q => q.text === 'Target platform?')
    expect(blocking?.blocking).toBe(true)
    expect(blocking?.source).toBe('configured')

    const second = await bridge.seedStageQuestions({
      stageId: 'stg-9',
      questions: [{ questionId: 'q1', text: 'Target platform?', required: true }],
    })
    expect(second.seeded).toHaveLength(0)
    const full = await store.getSession(first.sessionId)
    expect(full!.questions).toHaveLength(2)
    expect(full!.status).toBe('BLOCKED')
  })
})

describe('discovery bridge — RUN-scoped node seeding (Slice 4)', () => {
  it('seeds a workflow DISCOVERY node onto a RUN session, keyed and idempotent', async () => {
    const store = makeStore()
    const bridge = createDiscoveryBridge(store)
    const seed = () => bridge.seedSessionQuestions({
      scopeType: 'RUN',
      scopeId: 'inst-1',
      sourceType: 'workflow_discovery_node',
      keyPrefix: 'node-a',
      questions: [
        { questionId: '0', text: 'Which datastore?', required: true },
        { questionId: '1', text: 'Optional detail?', required: false },
      ],
    })
    const first = await seed()
    expect(first.seeded).toHaveLength(2)
    const blocking = first.seeded.find(q => q.text === 'Which datastore?')
    expect(blocking?.blocking).toBe(true)
    expect(blocking?.sourceType).toBe('workflow_discovery_node')
    expect(blocking?.sourceId).toBe('node-a:0')

    const session = await store.findSessionByScope('RUN', 'inst-1')
    expect((await store.getSession(session!.id))!.status).toBe('BLOCKED')

    const second = await seed()
    expect(second.seeded).toHaveLength(0)
    expect((await store.getSession(first.sessionId))!.questions).toHaveLength(2)
  })
})
