// ─────────────────────────────────────────────────────────────────────────────
// Builder — map a WorkGraph design-graph (the shape returned by
// GET /workflow-templates/:id/design-graph plus the workflow row) into a portable
// WorkflowDefinition, then into a signed .wgvm image. Mirrors the browser
// player's loadDefinition() so a VM run matches the studio run.
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkflowDefinition, EngineNodeDef, EngineEdge } from '@workgraph/engine'
import type { GovernancePolicySnapshot, WorkflowImage } from '../types.js'
import { buildImage } from '../image/format.js'

export interface DesignGraphNode {
  id: string
  nodeType: string
  label?: string | null
  config?: Record<string, unknown> | null
  positionX?: number
  positionY?: number
}

export interface DesignGraphEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  condition?: unknown
}

export interface DesignGraph {
  nodes: DesignGraphNode[]
  edges: DesignGraphEdge[]
}

export interface WorkflowMeta {
  id: string
  name: string
  currentVersion?: string | number
  updatedAt?: string
  variables?: WorkflowDefinition['variables']
}

export interface BuildFromDesignGraphInput {
  workflow: WorkflowMeta
  graph: DesignGraph
  globals?: Record<string, unknown>
  /** Governance policy snapshot to bundle (without its hash — computed here). */
  policy: Omit<GovernancePolicySnapshot, 'policyHash'>
  assets?: Record<string, string>
  signingPrivateKeyB64?: string
  signingPublicKeyB64?: string
  keyId?: string
  builtBy?: string
  now?: () => Date
}

export function toWorkflowDefinition(input: {
  workflow: WorkflowMeta
  graph: DesignGraph
  globals?: Record<string, unknown>
}): WorkflowDefinition {
  const nodes: EngineNodeDef[] = (input.graph.nodes ?? []).map(n => ({
    id: n.id,
    nodeType: n.nodeType,
    label: n.label ?? null,
    config: {
      ...(n.config ?? {}),
      ...(typeof n.positionX === 'number' ? { positionX: n.positionX } : {}),
      ...(typeof n.positionY === 'number' ? { positionY: n.positionY } : {}),
    },
  }))

  const edges: EngineEdge[] = (input.graph.edges ?? []).map(e => ({
    id: e.id,
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    edgeType: e.edgeType,
    condition: e.condition ?? null,
  }))

  return {
    workflowId: input.workflow.id,
    versionHash: String(input.workflow.currentVersion ?? input.workflow.updatedAt ?? 'unversioned'),
    name: input.workflow.name,
    variables: Array.isArray(input.workflow.variables) ? input.workflow.variables : [],
    globals: input.globals ?? {},
    nodes,
    edges,
  }
}

/** Adapter capabilities implied by a workflow's node types. */
export function requiredAdaptersFor(nodeTypes: string[]): string[] {
  const need = new Set<string>()
  for (const t of nodeTypes) {
    if (t === 'HUMAN_TASK' || t === 'APPROVAL') need.add('human')
    if (t === 'GOVERNANCE_GATE' || t === 'POLICY_CHECK') need.add('iam')
    if (t === 'DIRECT_LLM_TASK' || t === 'AGENT_TASK') need.add('llm')
    if (t === 'TOOL_REQUEST') need.add('tool')
    if (t === 'GIT_PUSH' || t === 'RAISE_PR' || t === 'CREATE_BRANCH') need.add('git')
  }
  return [...need].sort()
}

export function buildImageFromDesignGraph(input: BuildFromDesignGraphInput): WorkflowImage {
  const workflow = toWorkflowDefinition(input)
  const nodeTypes = [...new Set(workflow.nodes.map(n => n.nodeType))]
  return buildImage({
    workflow,
    policy: input.policy,
    assets: input.assets,
    requiredAdapters: requiredAdaptersFor(nodeTypes),
    signingPrivateKeyB64: input.signingPrivateKeyB64,
    signingPublicKeyB64: input.signingPublicKeyB64,
    keyId: input.keyId,
    builtBy: input.builtBy,
    now: input.now,
  })
}
