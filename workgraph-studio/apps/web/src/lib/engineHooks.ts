/**
 * React adapter for @workgraph/engine.
 *
 *   useRunPlayer(runId) → { state, runtime, definition, isLoading, error }
 *
 * Hydrates the run from IndexedDB (or server fallback), instantiates a
 * BrowserWorkflowRuntime once, subscribes to its emitter, persists every
 * mutation back to IndexedDB + pushes a snapshot to the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BrowserWorkflowRuntime,
  type RunState,
  type WorkflowDefinition,
  type EngineEdge,
  type EngineNodeDef,
} from '@workgraph/engine'
import { api } from './api'
import {
  saveRun,
  getRun,
  fetchSnapshot,
  pushSnapshot,
  listRuns,
  listMyRunSnapshots,
} from './runStore'

// ─── Definition hydration ───────────────────────────────────────────────────

export async function loadDefinition(workflowId: string): Promise<WorkflowDefinition> {
  // Workflow row first — we need its teamId + capabilityId to scope-filter globals.
  const { data: wf } = await api.get(`/workflow-templates/${workflowId}`)
  const teamId       = wf?.teamId as string | undefined
  const capabilityId = (wf?.capabilityId as string | null | undefined) ?? null

  const [{ data: graph }, { data: rawGlobals }] = await Promise.all([
    api.get(`/workflow-templates/${workflowId}/design-graph`),
    teamId
      ? api.get(`/teams/${teamId}/variables`).then(r => ({ data: r.data ?? [] }), () => ({ data: [] }))
      : Promise.resolve({ data: [] }),
  ])

  const nodes: EngineNodeDef[] = (graph.nodes ?? []).map((n: any) => ({
    id: n.id,
    nodeType: n.nodeType,
    label: n.label,
    config: {
      ...(n.config ?? {}),
      // Forward design-time x/y so the player can render a faithful canvas
      ...(typeof n.positionX === 'number' ? { positionX: n.positionX } : {}),
      ...(typeof n.positionY === 'number' ? { positionY: n.positionY } : {}),
    },
  }))

  const edges: EngineEdge[] = (graph.edges ?? []).map((e: any) => ({
    id: e.id,
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    edgeType: e.edgeType,
    condition: e.condition ?? null,
  }))

  // Scope-filter globals before they enter the run context.  A workflow sees:
  //   ORG_GLOBAL          — always
  //   CAPABILITY <capId>  — when capId === workflow.capabilityId
  //   WORKFLOW <wfId>     — when wfId === this workflow id
  // Later writes (CAPABILITY < ORG, WORKFLOW < CAPABILITY) override the same key.
  const globalsMap: Record<string, unknown> = {}
  if (Array.isArray(rawGlobals)) {
    const ordered = [
      ...rawGlobals.filter((g: any) => g.visibility === 'ORG_GLOBAL'),
      ...rawGlobals.filter((g: any) => g.visibility === 'CAPABILITY' && g.visibilityScopeId === capabilityId),
      ...rawGlobals.filter((g: any) => g.visibility === 'WORKFLOW'   && g.visibilityScopeId === workflowId),
    ]
    for (const g of ordered) globalsMap[g.key] = g.value
  }

  return {
    workflowId,
    versionHash: String(wf.currentVersion ?? wf.updatedAt ?? 'unversioned'),
    name: wf.name,
    variables: Array.isArray(wf.variables) ? wf.variables : [],
    globals: globalsMap,
    nodes,
    edges,
  }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseRunPlayerResult {
  state: RunState | null
  runtime: BrowserWorkflowRuntime | null
  definition: WorkflowDefinition | null
  isLoading: boolean
  error: Error | null
  reload: () => void
}

export function useRunPlayer(runId: string | undefined): UseRunPlayerResult {
  const [state, setState] = useState<RunState | null>(null)
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const runtimeRef = useRef<BrowserWorkflowRuntime | null>(null)
  const lastSyncedVersion = useRef<number>(0)

  const hydrate = useCallback(async () => {
    if (!runId) return
    setLoading(true)
    setError(null)
    try {
      // 1) prefer IndexedDB
      let run = await getRun(runId)

      // 2) fall back to server snapshot
      if (!run) {
        run = await fetchSnapshot(runId)
        if (run) await saveRun(run)
      }

      if (!run) throw new Error('Run not found in browser or server snapshot')

      // 3) load definition (for the engine to operate on)
      const def = await loadDefinition(run.workflowId)
      setDefinition(def)

      // 4) instantiate runtime
      const rt = new BrowserWorkflowRuntime(run, def)
      runtimeRef.current = rt
      setState(rt.getState())

      // Subscribe → save + push
      rt.subscribe(async (next) => {
        setState(next)
        await saveRun(next)
        if (next.version > lastSyncedVersion.current) {
          lastSyncedVersion.current = next.version
          // fire-and-forget snapshot push
          pushSnapshot(next).then((res) => {
            if (res.conflict) {
              // pull from server, replay would need re-instantiation — for v1 just reload
              // (rare path; documented as a known limitation)
              console.warn('[runPlayer] snapshot conflict — server has newer version')
            }
          })
        }
      })

      lastSyncedVersion.current = run.version
    } catch (e: any) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => { void hydrate() }, [hydrate])

  // Periodic heartbeat — push current snapshot every 30s if we've made progress
  useEffect(() => {
    if (!runId) return
    const id = setInterval(() => {
      const cur = runtimeRef.current?.getState()
      if (cur && cur.version > lastSyncedVersion.current) {
        lastSyncedVersion.current = cur.version
        pushSnapshot(cur).catch(() => { /* ignore */ })
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [runId])

  return {
    state,
    runtime: runtimeRef.current,
    definition,
    isLoading,
    error,
    reload: hydrate,
  }
}

// ─── New-run bootstrap ─────────────────────────────────────────────────────

export async function createBrowserRun(opts: {
  workflowId: string
  name: string
  params?: Record<string, unknown>
  globalsOverride?: Record<string, unknown>
  createdById?: string
}): Promise<RunState> {
  const definition = await loadDefinition(opts.workflowId)
  const uniqueName = await disambiguateRunName(opts.name, opts.workflowId)
  const initial = BrowserWorkflowRuntime.initRunState({
    definition,
    name: uniqueName,
    params: opts.params,
    globals: opts.globalsOverride,
    createdById: opts.createdById,
  })
  await saveRun(initial)
  // Best-effort initial snapshot push so the dashboard sees it
  pushSnapshot(initial).catch(() => { /* ignore */ })
  return initial
}

/**
 * Returns a name that doesn't collide with any existing run for this workflow,
 * checking both IndexedDB (this browser) and the server snapshot list (other
 * tabs / devices). Appends " (2)", " (3)", … as needed.
 */
async function disambiguateRunName(desired: string, workflowId: string): Promise<string> {
  const trimmed = desired.trim() || 'Untitled run'
  const taken = new Set<string>()

  try {
    const local = await listRuns({ workflowId })
    for (const r of local) taken.add(r.name)
  } catch { /* ignore */ }

  try {
    const remote = await listMyRunSnapshots()
    for (const r of remote) if (r.workflowId === workflowId) taken.add(r.name)
  } catch { /* ignore */ }

  if (!taken.has(trimmed)) return trimmed

  // Strip a trailing " (n)" if any so we increment cleanly
  const base = trimmed.replace(/\s+\((\d+)\)$/, '')
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} (${Date.now()})`
}
