import { describe, it, expect } from 'vitest'
import { buildPlanWorkflowGraph, designNodeCreateData, remapEdgeCreateData } from '../src/modules/planner/planner-graph'
import type { Milestone } from '../src/modules/planner/planner.service'

function counter(): () => string {
  let n = 0
  return () => `id-${(n += 1)}`
}

const milestone = (id: string, title: string, tasks: Array<{ title: string; description: string }> = []): Milestone => ({
  id,
  title,
  summary: '',
  tasks: tasks.map((task) => ({ ...task, category: '', capabilityId: 'cap', priority: 'MEDIUM' as const, effortDays: 1, aiSuggested: false })),
})

describe('buildPlanWorkflowGraph', () => {
  it('emits START → a DIRECT_LLM_TASK per milestone → GOVERNANCE_GATE → END, sequentially linked', () => {
    const graph = buildPlanWorkflowGraph({
      capabilityId: 'cap-1',
      milestones: [milestone('M1', 'Foundation', [{ title: 'Schema', description: 'db' }]), milestone('M2', 'API')],
      modelAlias: 'balanced',
      governancePreset: 'standard',
      makeId: counter(),
    })
    expect(graph.nodes.map((node) => node.nodeType)).toEqual(['START', 'DIRECT_LLM_TASK', 'DIRECT_LLM_TASK', 'GOVERNANCE_GATE', 'END'])
    expect(graph.nodes[1].label).toBe('M1: Foundation')
    // one edge per adjacent pair; every non-START node has an inbound edge
    expect(graph.edges).toHaveLength(graph.nodes.length - 1)
    expect(graph.edges.every((edge) => edge.edgeType === 'SEQUENTIAL')).toBe(true)
    const targets = new Set(graph.edges.map((edge) => edge.targetNodeId))
    for (const node of graph.nodes.slice(1)) expect(targets.has(node.id)).toBe(true)
    // milestone node config carries the grounding needed to run it
    expect(graph.nodes[1].config?.capabilityId).toBe('cap-1')
    expect(graph.nodes[1].config?.modelAlias).toBe('balanced')
    expect(String(graph.nodes[1].config?.prompt)).toContain('Schema')
  })

  it('omits the governance gate when no preset is chosen and no modelAlias leaks in', () => {
    const graph = buildPlanWorkflowGraph({ capabilityId: 'cap', milestones: [milestone('M1', 'Only')], makeId: counter() })
    expect(graph.nodes.map((node) => node.nodeType)).toEqual(['START', 'DIRECT_LLM_TASK', 'END'])
    expect(graph.nodes[1].config?.modelAlias).toBeUndefined()
  })

  it('falls back to a single work node for an empty roadmap so the graph stays runnable', () => {
    const graph = buildPlanWorkflowGraph({ capabilityId: 'cap', milestones: [], goal: 'ship it', makeId: counter() })
    expect(graph.nodes.map((node) => node.nodeType)).toEqual(['START', 'DIRECT_LLM_TASK', 'END'])
    expect(graph.nodes[1].label).toContain('ship it')
  })

  it('produces valid edge references — every endpoint is a real node', () => {
    const graph = buildPlanWorkflowGraph({
      capabilityId: 'cap',
      milestones: [milestone('M1', 'A'), milestone('M2', 'B')],
      governancePreset: 'strict',
      makeId: counter(),
    })
    const ids = new Set(graph.nodes.map((node) => node.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.sourceNodeId)).toBe(true)
      expect(ids.has(edge.targetNodeId)).toBe(true)
    }
  })
})

describe('persistence mapping (pure) — generated graph → design rows', () => {
  it('designNodeCreateData carries workflowId, SERVER execution, and a defaulted config', () => {
    const [start] = buildPlanWorkflowGraph({ capabilityId: 'cap', milestones: [milestone('M1', 'A')], makeId: counter() }).nodes
    const data = designNodeCreateData(start, 'wf-1')
    expect(data).toMatchObject({ workflowId: 'wf-1', nodeType: 'START', label: 'Start', executionLocation: 'SERVER', config: {} })
    expect(typeof data.positionX).toBe('number')
    expect(typeof data.positionY).toBe('number')
  })

  it('remapEdgeCreateData rewrites temp node ids to persisted DB ids, preserving the chain', () => {
    const graph = buildPlanWorkflowGraph({
      capabilityId: 'cap',
      milestones: [milestone('M1', 'A'), milestone('M2', 'B')],
      governancePreset: 'standard',
      makeId: counter(),
    })
    const idMap = new Map(graph.nodes.map((node, i) => [node.id, `db-${i}`])) // simulate DB-assigned ids
    const edges = remapEdgeCreateData(graph.edges, idMap, 'wf-1')
    expect(edges).toHaveLength(graph.edges.length)
    for (const edge of edges) {
      expect(edge.workflowId).toBe('wf-1')
      expect(edge.sourceNodeId).toMatch(/^db-/)
      expect(edge.targetNodeId).toMatch(/^db-/)
      expect(edge.edgeType).toBe('SEQUENTIAL')
    }
    expect(edges[0].sourceNodeId).toBe('db-0') // the START node
  })

  it('remapEdgeCreateData throws on a dangling reference — a persistence bug, not user input', () => {
    const graph = buildPlanWorkflowGraph({ capabilityId: 'cap', milestones: [milestone('M1', 'A')], makeId: counter() })
    const incomplete = new Map([[graph.nodes[0].id, 'db-0']]) // only START mapped
    expect(() => remapEdgeCreateData(graph.edges, incomplete, 'wf-1')).toThrow(/unpersisted node/)
  })
})
