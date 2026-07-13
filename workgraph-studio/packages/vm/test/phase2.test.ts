import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowDefinition } from '@workgraph/engine'
import {
  buildImage,
  buildImageFromDesignGraph,
  verifyImage,
  WorkflowVm,
  SqliteStateStore,
  offlineAdapters,
  httpAdapters,
  mergeAdapters,
  syncOutbox,
  type Adapters,
  type Clock,
  type LlmAdapter,
  type McpToolAdapter,
} from '../src/index.js'

function store() {
  const s = new SqliteStateStore(':memory:')
  s.init()
  return s
}

const basePolicy = {
  gatedNodeTypes: [] as string[],
  allowedCapabilities: [] as string[],
  approvalRequiredNodeTypes: [] as string[],
  failClosed: true,
}

// ── Builder: design-graph → image → run ─────────────────────────────────────

test('builds an image from a design-graph and runs it to completion', async () => {
  const image = buildImageFromDesignGraph({
    workflow: { id: 'wf-dg', name: 'FromGraph', currentVersion: 3 },
    graph: {
      nodes: [
        { id: 'start', nodeType: 'START' },
        { id: 'set', nodeType: 'SET_CONTEXT', config: { assignments: [{ path: 'context.hello', value: 'world' }] } },
        { id: 'end', nodeType: 'END' },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', targetNodeId: 'set', edgeType: 'SEQUENTIAL' },
        { id: 'e2', sourceNodeId: 'set', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
      ],
    },
    policy: basePolicy,
  })
  verifyImage(image)
  assert.equal(image.manifest.workflowId, 'wf-dg')
  assert.equal(image.manifest.versionHash, '3')
  assert.deepEqual([...image.manifest.nodeTypes].sort(), ['END', 'SET_CONTEXT', 'START'])

  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.context.hello, 'world')
})

test('design-graph manifest advertises required adapters from node types', () => {
  const image = buildImageFromDesignGraph({
    workflow: { id: 'wf-caps', name: 'Caps' },
    graph: {
      nodes: [
        { id: 'llm', nodeType: 'DIRECT_LLM_TASK' },
        { id: 'tool', nodeType: 'TOOL_REQUEST' },
        { id: 'git', nodeType: 'GIT_PUSH' },
      ],
      edges: [],
    },
    policy: basePolicy,
  })
  assert.deepEqual(image.manifest.requiredAdapters, ['git', 'llm', 'tool'])
})

// ── LLM task executor ────────────────────────────────────────────────────────

const llmWorkflow: WorkflowDefinition = {
  workflowId: 'wf-llm',
  versionHash: 'v1',
  name: 'Llm',
  nodes: [
    { id: 'start', nodeType: 'START' },
    { id: 'ask', nodeType: 'DIRECT_LLM_TASK', config: { prompt: 'say hi' } },
    { id: 'end', nodeType: 'END' },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'ask', edgeType: 'SEQUENTIAL' },
    { id: 'e2', sourceNodeId: 'ask', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
  ],
}

test('LLM task completes online via an injected adapter', async () => {
  const image = buildImage({ workflow: llmWorkflow, policy: basePolicy })
  const s = store()
  const onlineLlm: LlmAdapter = {
    online: () => true,
    complete: async input => ({ text: `echo:${input.prompt}` }),
  }
  const adapters: Adapters = { ...offlineAdapters(s), llm: onlineLlm }
  const vm = new WorkflowVm({ image, store: s, adapters })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.deepEqual(state.nodes['ask'].output, { text: 'echo:say hi' })
})

test('LLM task blocks offline, then resumes online', async () => {
  const image = buildImage({ workflow: llmWorkflow, policy: basePolicy })
  const s = store()

  const vm1 = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const parked = await vm1.start({}, { runId: 'run-llm' })
  assert.equal(parked.status, 'BLOCKED')
  assert.equal(parked.nodes['ask'].status, 'BLOCKED')

  const onlineLlm: LlmAdapter = { online: () => true, complete: async () => ({ text: 'done' }) }
  const vm2 = new WorkflowVm({ image, store: s, adapters: { ...offlineAdapters(s), llm: onlineLlm } })
  const done = await vm2.resume('run-llm')
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.nodes['end'].status, 'COMPLETED')
})

// ── Tool request executor ────────────────────────────────────────────────────

test('TOOL_REQUEST completes online via an injected adapter', async () => {
  const wf: WorkflowDefinition = {
    workflowId: 'wf-tool',
    versionHash: 'v1',
    name: 'Tool',
    nodes: [
      { id: 'start', nodeType: 'START' },
      { id: 't', nodeType: 'TOOL_REQUEST', config: { toolId: 'search', inputPayload: { q: 'x' } } },
      { id: 'end', nodeType: 'END' },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 't', edgeType: 'SEQUENTIAL' },
      { id: 'e2', sourceNodeId: 't', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
    ],
  }
  const image = buildImage({ workflow: wf, policy: basePolicy })
  const s = store()
  const onlineTool: McpToolAdapter = {
    online: () => true,
    invoke: async input => ({ result: { tool: input.tool, echoed: input.params } }),
  }
  const vm = new WorkflowVm({ image, store: s, adapters: { ...offlineAdapters(s), tool: onlineTool } })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.deepEqual(state.nodes['t'].output, { result: { tool: 'search', echoed: { q: 'x' } } })
})

// ── Timer executor (deterministic, park/resume) ──────────────────────────────

function mutableClock(start: Date): { clock: Clock; set: (d: Date) => void } {
  let cur = start
  return { clock: { now: () => cur }, set: d => { cur = d } }
}

test('TIMER completes immediately when the fire time is in the past', async () => {
  const wf: WorkflowDefinition = {
    workflowId: 'wf-timer-past',
    versionHash: 'v1',
    name: 'TimerPast',
    nodes: [
      { id: 'start', nodeType: 'START' },
      { id: 'wait', nodeType: 'TIMER', config: { until: '2000-01-01T00:00:00.000Z' } },
      { id: 'end', nodeType: 'END' },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'wait', edgeType: 'SEQUENTIAL' },
      { id: 'e2', sourceNodeId: 'wait', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
    ],
  }
  const image = buildImage({ workflow: wf, policy: basePolicy })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.nodes['wait'].status, 'COMPLETED')
})

test('TIMER parks for a future fire time, then completes once the clock passes it', async () => {
  const wf: WorkflowDefinition = {
    workflowId: 'wf-timer-future',
    versionHash: 'v1',
    name: 'TimerFuture',
    nodes: [
      { id: 'start', nodeType: 'START' },
      { id: 'wait', nodeType: 'TIMER', config: { durationMs: 60_000 } },
      { id: 'end', nodeType: 'END' },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'wait', edgeType: 'SEQUENTIAL' },
      { id: 'e2', sourceNodeId: 'wait', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
    ],
  }
  const image = buildImage({ workflow: wf, policy: basePolicy })
  const s = store()
  const mc = mutableClock(new Date('2024-01-01T00:00:00.000Z'))
  const adapters: Adapters = { ...offlineAdapters(s), clock: mc.clock }

  const vm1 = new WorkflowVm({ image, store: s, adapters, clock: mc.clock })
  const parked = await vm1.start({}, { runId: 'run-timer' })
  assert.equal(parked.status, 'BLOCKED')
  assert.equal(parked.nodes['wait'].status, 'BLOCKED')

  // Advance past the fire time and resume.
  mc.set(new Date('2024-01-01T00:02:00.000Z'))
  const vm2 = new WorkflowVm({ image, store: s, adapters, clock: mc.clock })
  const done = await vm2.resume('run-timer')
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.nodes['end'].status, 'COMPLETED')
})

// ── HTTP adapters + mergeAdapters (injected fetch) ──────────────────────────

test('httpAdapters call the configured endpoint via injected fetch', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
    calls.push(url)
    const body = JSON.parse(init.body as string)
    return new Response(JSON.stringify({ text: `remote:${body.prompt}` }), { status: 200 })
  }) as unknown as typeof fetch

  const online = httpAdapters({ llm: { baseUrl: 'https://api.example.com', token: 't' }, fetchImpl })
  assert.equal(online.llm.online(), true)
  const res = await online.llm.complete({ prompt: 'hey' })
  assert.equal(res.text, 'remote:hey')
  assert.equal(calls[0], 'https://api.example.com/api/v1/complete')
})

test('mergeAdapters prefers online capability and falls back otherwise', () => {
  const s = store()
  const offline = offlineAdapters(s)
  const online = httpAdapters({ llm: { baseUrl: 'https://api.example.com' } })
  const merged = mergeAdapters(online, offline)
  assert.equal(merged.llm.online(), true) // from online
  assert.equal(merged.iam.online(), false) // fell back to offline
})

// ── Receipt sync (replay outbox → audit-gov) ─────────────────────────────────

test('syncOutbox replays queued audit events and marks them synced', async () => {
  const image = buildImage({
    workflow: {
      workflowId: 'wf-sync',
      versionHash: 'v1',
      name: 'Sync',
      nodes: [
        { id: 'start', nodeType: 'START' },
        { id: 'set', nodeType: 'SET_CONTEXT', config: { assignments: [{ path: 'context.x', value: 1 }] } },
        { id: 'end', nodeType: 'END' },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', targetNodeId: 'set', edgeType: 'SEQUENTIAL' },
        { id: 'e2', sourceNodeId: 'set', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
      ],
    },
    policy: basePolicy,
  })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  await vm.start({})
  assert.ok(s.pendingOutbox().length > 0)

  const seen: string[] = []
  const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    seen.push(headers['idempotency-key'])
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const result = await syncOutbox(s, { baseUrl: 'https://audit.example.com', token: 'tok', fetchImpl })
  assert.equal(result.failed, 0)
  assert.ok(result.synced > 0)
  assert.equal(result.synced, result.attempted)
  assert.equal(seen.length, result.synced)
  // Idempotency keys are the outbox entry ids.
  assert.equal(new Set(seen).size, seen.length)
  // Nothing left pending.
  assert.equal(s.pendingOutbox().length, 0)
})
