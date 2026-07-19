import { randomUUID } from 'crypto'
import type { Milestone } from './planner.service'

/**
 * Deterministic roadmap → runnable workflow-graph generator (Phase 2 of the planner).
 *
 * The planner's LLM already produced the grounded, milestone-grouped roadmap; turning
 * it into a workflow DAG is a pure structural transform — no second LLM call, no
 * hallucinated node types, fully unit-testable. It emits the platform's real design
 * node/edge shape (NodeType + SEQUENTIAL edges referencing node ids):
 *
 *   START → [DIRECT_LLM_TASK per milestone] → (GOVERNANCE_GATE) → END
 *
 * Each milestone becomes a DIRECT_LLM_TASK whose prompt is the milestone's tasks +
 * acceptance criteria. The chosen loop strategy is NOT pinned per node — it applies
 * run-level via _globals/_vars.loopStrategyId (see DirectLlmTaskExecutor's run-level
 * fallback), so a generated graph and a launch-time strategy compose cleanly.
 */

export type GeneratedNode = {
  id: string
  nodeType: 'START' | 'END' | 'DIRECT_LLM_TASK' | 'GOVERNANCE_GATE'
  label: string
  config?: Record<string, unknown>
  positionX: number
  positionY: number
}

export type GeneratedEdge = {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: 'SEQUENTIAL'
}

export type GeneratedGraph = {
  nodes: GeneratedNode[]
  edges: GeneratedEdge[]
}

export type BuildPlanGraphInput = {
  milestones: Milestone[]
  capabilityId: string
  modelAlias?: string
  loopStrategyId?: string
  governancePreset?: string
  goal?: string
  // Injectable id factory so tests can assert a deterministic graph.
  makeId?: () => string
}

const LANE_X = 240
const ROW_GAP = 150

function milestonePrompt(milestone: Milestone, goal?: string): string {
  const tasks = milestone.tasks.map((task) => `- ${task.title}: ${task.description}`).join('\n')
  return [
    goal ? `Overall goal: ${goal}` : '',
    `Milestone: ${milestone.title}`,
    milestone.summary ? milestone.summary : '',
    tasks ? `Deliver these tasks with acceptance criteria:\n${tasks}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Turn a planner roadmap into a runnable workflow graph (design nodes + edges). */
export function buildPlanWorkflowGraph(input: BuildPlanGraphInput): GeneratedGraph {
  const nextId = input.makeId ?? (() => randomUUID())
  const nodes: GeneratedNode[] = []
  const edges: GeneratedEdge[] = []
  let row = 0

  const add = (node: Omit<GeneratedNode, 'id' | 'positionX' | 'positionY'>): GeneratedNode => {
    const full: GeneratedNode = { id: nextId(), positionX: LANE_X, positionY: row * ROW_GAP, ...node }
    nodes.push(full)
    row += 1
    return full
  }
  const connect = (source: string, target: string) => {
    edges.push({ id: nextId(), sourceNodeId: source, targetNodeId: target, edgeType: 'SEQUENTIAL' })
  }

  const start = add({ nodeType: 'START', label: 'Start' })
  let previous = start.id

  // Guard against an empty roadmap: still emit a single work node so the graph is runnable.
  const milestones: Milestone[] = input.milestones.length
    ? input.milestones
    : [{ id: 'M1', title: input.goal?.slice(0, 80) || 'Deliver the requested change', summary: '', tasks: [] }]

  milestones.forEach((milestone, index) => {
    const node = add({
      nodeType: 'DIRECT_LLM_TASK',
      label: `M${index + 1}: ${milestone.title}`.slice(0, 120),
      config: {
        capabilityId: input.capabilityId,
        milestoneId: milestone.id,
        ...(input.modelAlias ? { modelAlias: input.modelAlias } : {}),
        prompt: milestonePrompt(milestone, input.goal),
      },
    })
    connect(previous, node.id)
    previous = node.id
  })

  if (input.governancePreset) {
    const gate = add({
      nodeType: 'GOVERNANCE_GATE',
      label: 'Governance review',
      config: { governancePreset: input.governancePreset, capabilityId: input.capabilityId },
    })
    connect(previous, gate.id)
    previous = gate.id
  }

  const end = add({ nodeType: 'END', label: 'End' })
  connect(previous, end.id)

  return { nodes, edges }
}

/* ── Persistence mapping (pure) — consumed by planner.service.persistPlanGraph ──────────
 * The generator emits temporary node ids and edges that reference them. Persisting creates
 * WorkflowDesignNode rows whose DB ids differ, so edges must be remapped temp→real. Keeping
 * that mapping in pure functions makes it unit-testable without a database. */

export type DesignNodeCreateData = {
  workflowId: string
  nodeType: GeneratedNode['nodeType']
  label: string
  config: Record<string, unknown>
  executionLocation: 'SERVER'
  positionX: number
  positionY: number
}
export type DesignEdgeCreateData = {
  workflowId: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: GeneratedEdge['edgeType']
}

/** The create-row for one generated node (generated nodes run in-process → SERVER). */
export function designNodeCreateData(node: GeneratedNode, workflowId: string): DesignNodeCreateData {
  return {
    workflowId,
    nodeType: node.nodeType,
    label: node.label,
    config: node.config ?? {},
    executionLocation: 'SERVER',
    positionX: node.positionX,
    positionY: node.positionY,
  }
}

/**
 * Remap generated edges (which reference temporary node ids) onto the persisted DB node ids.
 * Throws on a dangling reference — a generated graph never emits one, so an unknown id is a
 * persistence bug, not user input; failing loudly beats silently dropping an edge.
 */
export function remapEdgeCreateData(edges: GeneratedEdge[], idMap: Map<string, string>, workflowId: string): DesignEdgeCreateData[] {
  return edges.map((edge) => {
    const sourceNodeId = idMap.get(edge.sourceNodeId)
    const targetNodeId = idMap.get(edge.targetNodeId)
    if (!sourceNodeId || !targetNodeId) {
      throw new Error(`planner graph edge ${edge.id} references an unpersisted node (${edge.sourceNodeId} -> ${edge.targetNodeId})`)
    }
    return { workflowId, sourceNodeId, targetNodeId, edgeType: edge.edgeType }
  })
}
