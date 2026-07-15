import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowDefinition } from '@workgraph/engine'
import {
  buildImage,
  verifyImage,
  WorkflowVm,
  SqliteStateStore,
  offlineAdapters,
  requiredAdaptersFor,
  readSeedQuestions,
  hasBlockingOpen,
  type Adapters,
  type DiscoveryAdapter,
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

// start → discovery → end
function discoveryWorkflow(config: Record<string, unknown>): WorkflowDefinition {
  return {
    workflowId: 'wf-disc',
    versionHash: 'v1',
    name: 'Discovery',
    nodes: [
      { id: 'start', nodeType: 'START' },
      { id: 'disc', nodeType: 'DISCOVERY', config },
      { id: 'end', nodeType: 'END' },
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'disc', edgeType: 'SEQUENTIAL' },
      { id: 'e2', sourceNodeId: 'disc', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
    ],
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('readSeedQuestions maps required/blocking and drops textless entries', () => {
  const qs = readSeedQuestions({
    questions: [
      { text: 'A?', required: true },
      { text: 'B?', blocking: true },
      { text: 'C?' },
      { text: '' },
      { nope: 1 },
    ],
  })
  assert.equal(qs.length, 3)
  assert.equal(qs[0].blocking, true)
  assert.equal(qs[1].blocking, true)
  assert.equal(qs[2].blocking, false)
})

test('hasBlockingOpen respects status', () => {
  assert.equal(hasBlockingOpen([{ text: 'x', blocking: true, status: 'OPEN' }]), true)
  assert.equal(hasBlockingOpen([{ text: 'x', blocking: true, status: 'ANSWERED' }]), false)
  assert.equal(hasBlockingOpen([{ text: 'x', blocking: false, status: 'OPEN' }]), false)
})

test('requiredAdaptersFor includes discovery for a DISCOVERY node', () => {
  assert.deepEqual(requiredAdaptersFor(['DISCOVERY']), ['discovery'])
})

// ── executor behaviour ───────────────────────────────────────────────────────

test('DISCOVERY completes when the online elicit returns no blocking-open questions', async () => {
  const image = buildImage({ workflow: discoveryWorkflow({ hint: 'scope it' }), policy: basePolicy })
  verifyImage(image)
  const s = store()
  const onlineDiscovery: DiscoveryAdapter = {
    online: () => true,
    elicit: async () => ({
      questions: [{ text: 'Which region?', blocking: false, status: 'OPEN' }],
      assumptions: [{ text: 'us-east-1', confidence: 0.6 }],
    }),
  }
  const adapters: Adapters = { ...offlineAdapters(s), discovery: onlineDiscovery }
  const vm = new WorkflowVm({ image, store: s, adapters })
  const state = await vm.start({}, { runId: 'run-d1' })
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.nodes['disc'].status, 'COMPLETED')
  const out = state.context.disc as { status: string; assumptions: unknown[] }
  assert.equal(out.status, 'RESOLVED')
  assert.equal(out.assumptions.length, 1)
})

test('DISCOVERY blocks when the online elicit surfaces a blocking-open question, then resumes when answered', async () => {
  const image = buildImage({ workflow: discoveryWorkflow({}), policy: basePolicy })
  const s = store()

  // First pass: elicit surfaces a blocking OPEN question → park.
  const blocking: DiscoveryAdapter = {
    online: () => true,
    elicit: async () => ({ questions: [{ id: 'q1', text: 'Approved budget?', blocking: true, status: 'OPEN' }], assumptions: [] }),
  }
  const vm1 = new WorkflowVm({ image, store: s, adapters: { ...offlineAdapters(s), discovery: blocking } })
  const parked = await vm1.start({}, { runId: 'run-d2' })
  assert.equal(parked.status, 'BLOCKED')
  assert.equal(parked.nodes['disc'].status, 'BLOCKED')
  assert.equal(parked.nodes['end'].status, 'PENDING')

  // Reconnect: the question is now answered → node clears.
  const answered: DiscoveryAdapter = {
    online: () => true,
    elicit: async () => ({ questions: [{ id: 'q1', text: 'Approved budget?', blocking: true, status: 'ANSWERED', answer: 'yes' }], assumptions: [] }),
  }
  const vm2 = new WorkflowVm({ image, store: s, adapters: { ...offlineAdapters(s), discovery: answered } })
  const done = await vm2.resume('run-d2')
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.nodes['disc'].status, 'COMPLETED')
  assert.equal(done.nodes['end'].status, 'COMPLETED')
})

test('DISCOVERY blocks offline when it carries blocking seed questions (fail-closed on unknowns)', async () => {
  const image = buildImage({
    workflow: discoveryWorkflow({ questions: [{ text: 'Target platform?', required: true }] }),
    policy: basePolicy,
  })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const parked = await vm.start({}, { runId: 'run-d3' })
  assert.equal(parked.status, 'BLOCKED')
  assert.equal(parked.nodes['disc'].status, 'BLOCKED')
})

test('DISCOVERY passes through offline when there are no blocking seed questions', async () => {
  const image = buildImage({
    workflow: discoveryWorkflow({ questions: [{ text: 'Nice to have?', required: false }] }),
    policy: basePolicy,
  })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({}, { runId: 'run-d4' })
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.nodes['disc'].status, 'COMPLETED')
  const out = state.context.disc as { degraded?: string }
  assert.equal(out.degraded, 'offline')
})
