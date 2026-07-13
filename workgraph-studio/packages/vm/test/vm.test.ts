import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowDefinition } from '@workgraph/engine'
import {
  buildImage,
  verifyImage,
  WorkflowVm,
  SqliteStateStore,
  offlineAdapters,
  type Adapters,
  type HumanTaskAdapter,
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

// start → set tier → decision gate → (premium | standard) → end
const branchingWorkflow: WorkflowDefinition = {
  workflowId: 'wf-branch',
  versionHash: 'v1',
  name: 'Branching',
  nodes: [
    { id: 'start', nodeType: 'START' },
    { id: 'set', nodeType: 'SET_CONTEXT', config: { assignments: [{ path: 'vars.tier', value: 'premium' }] } },
    { id: 'gate', nodeType: 'DECISION_GATE' },
    { id: 'premium', nodeType: 'SET_CONTEXT', config: { assignments: [{ path: 'context.route', value: 'PREMIUM' }] } },
    { id: 'standard', nodeType: 'SET_CONTEXT', config: { assignments: [{ path: 'context.route', value: 'STANDARD' }] } },
    { id: 'end', nodeType: 'END' },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'set', edgeType: 'SEQUENTIAL' },
    { id: 'e2', sourceNodeId: 'set', targetNodeId: 'gate', edgeType: 'SEQUENTIAL' },
    {
      id: 'e3',
      sourceNodeId: 'gate',
      targetNodeId: 'premium',
      edgeType: 'CONDITIONAL',
      condition: { priority: 0, conditions: [{ left: 'vars.tier', op: '==', right: 'premium' }] },
    },
    {
      id: 'e4',
      sourceNodeId: 'gate',
      targetNodeId: 'standard',
      edgeType: 'CONDITIONAL',
      condition: { priority: 1, isDefault: true, conditions: [] },
    },
    { id: 'e5', sourceNodeId: 'premium', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
    { id: 'e6', sourceNodeId: 'standard', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
  ],
}

test('runs a deterministic branching workflow to completion offline', async () => {
  const image = buildImage({ workflow: branchingWorkflow, policy: basePolicy })
  verifyImage(image)
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.context.route, 'PREMIUM')
  assert.equal(state.nodes['standard'].status, 'PENDING') // branch not taken
  assert.equal(state.nodes['premium'].status, 'COMPLETED')
  // Receipts were chained.
  const receipts = s.listReceipts(state.runId)
  assert.ok(receipts.length >= 4)
  assert.equal(receipts[0].prevHash, 'GENESIS')
  for (let i = 1; i < receipts.length; i++) {
    assert.equal(receipts[i].prevHash, receipts[i - 1].hash)
  }
})

// start → human approval → end
const humanWorkflow: WorkflowDefinition = {
  workflowId: 'wf-human',
  versionHash: 'v1',
  name: 'Human',
  nodes: [
    { id: 'start', nodeType: 'START' },
    { id: 'approve', nodeType: 'HUMAN_TASK', config: { title: 'Approve me' } },
    { id: 'end', nodeType: 'END' },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'approve', edgeType: 'SEQUENTIAL' },
    { id: 'e2', sourceNodeId: 'approve', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
  ],
}

test('human task BLOCKS offline, then resumes when the adapter is online', async () => {
  const image = buildImage({ workflow: humanWorkflow, policy: basePolicy })
  const s = store()

  // First pass: offline → the human node parks the run.
  const vm1 = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const parked = await vm1.start({}, { runId: 'run-h' })
  assert.equal(parked.status, 'BLOCKED')
  assert.equal(parked.nodes['approve'].status, 'BLOCKED')
  assert.equal(parked.nodes['end'].status, 'PENDING')

  // Reconnect: an online human adapter that approves.
  const onlineHuman: HumanTaskAdapter = {
    online: () => true,
    requestDecision: async () => ({ decision: 'APPROVED', by: 'alice' }),
  }
  const adapters: Adapters = { ...offlineAdapters(s), human: onlineHuman }
  const vm2 = new WorkflowVm({ image, store: s, adapters })
  const done = await vm2.resume('run-h')
  assert.equal(done.status, 'COMPLETED')
  assert.equal(done.nodes['approve'].status, 'COMPLETED')
  assert.equal(done.nodes['end'].status, 'COMPLETED')
})

// start → governance gate → end  (gated, offline, fail-closed)
const governedWorkflow: WorkflowDefinition = {
  workflowId: 'wf-gov',
  versionHash: 'v1',
  name: 'Governed',
  nodes: [
    { id: 'start', nodeType: 'START' },
    { id: 'gate', nodeType: 'GOVERNANCE_GATE', config: { capabilityId: 'cap.dangerous' } },
    { id: 'end', nodeType: 'END' },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'start', targetNodeId: 'gate', edgeType: 'SEQUENTIAL' },
    { id: 'e2', sourceNodeId: 'gate', targetNodeId: 'end', edgeType: 'SEQUENTIAL' },
  ],
}

test('governance gate blocks offline when fail-closed', async () => {
  const image = buildImage({ workflow: governedWorkflow, policy: basePolicy })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({})
  assert.equal(state.status, 'BLOCKED')
  assert.equal(state.nodes['gate'].status, 'BLOCKED')
})

test('governance gate clears offline when capability is bundle-allowed', async () => {
  const image = buildImage({
    workflow: governedWorkflow,
    policy: { ...basePolicy, allowedCapabilities: ['cap.dangerous'] },
  })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  const state = await vm.start({})
  assert.equal(state.status, 'COMPLETED')
  assert.equal(state.nodes['gate'].status, 'COMPLETED')
})

test('offline audit events are queued in the outbox, never dropped', async () => {
  const image = buildImage({ workflow: branchingWorkflow, policy: basePolicy })
  const s = store()
  const vm = new WorkflowVm({ image, store: s, adapters: offlineAdapters(s) })
  await vm.start({})
  const pending = s.pendingOutbox()
  assert.ok(pending.length > 0)
  assert.ok(pending.every(p => p.kind.startsWith('audit:')))
})
