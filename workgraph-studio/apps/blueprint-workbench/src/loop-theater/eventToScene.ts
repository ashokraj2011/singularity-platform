/**
 * M69 Loop Theater — Event → scene action mapper.
 *
 * audit-gov emits one event per LLM call, tool invocation, phase
 * transition, etc. The theater renders a smaller, opinionated set of
 * "scene actions" — each one is a thing a human watcher can follow.
 *
 * Keep this file purely declarative: input is an audit-gov event,
 * output is either a SceneAction or null. No DOM, no state, no async.
 */
export type SceneActor = 'llm' | 'agent' | 'system'

export type SceneAction =
  | {
      id: string
      kind: 'llm-speaks'
      actor: 'llm'
      at: string // ISO timestamp
      preview: string // first ~120 chars of LLM response
      tokens?: { input: number; output: number; cost?: number }
      raw: unknown // original event for the detail drawer
    }
  | {
      id: string
      kind: 'tool-call'
      actor: 'agent'
      at: string
      toolName: string
      argPreview: string // 1-line summary of args
      raw: unknown
    }
  | {
      id: string
      kind: 'tool-result'
      actor: 'agent'
      at: string
      toolName: string
      passed?: boolean
      success?: boolean
      summary: string // 1-line summary of output
      raw: unknown
    }
  | {
      id: string
      kind: 'phase-change'
      actor: 'system'
      at: string
      phase: string // EXPLORE / ACT / VERIFY / etc.
      raw: unknown
    }
  | {
      id: string
      kind: 'code-change'
      actor: 'agent'
      at: string
      paths: string[]
      commitSha?: string
      raw: unknown
    }
  | {
      id: string
      kind: 'finish'
      actor: 'agent'
      at: string
      passed: boolean
      reason?: string
      raw: unknown
    }

export interface AuditEvent {
  id: string
  trace_id?: string | null
  kind: string
  payload?: Record<string, unknown> | null
  created_at?: string
  occurred_at?: string
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function truncate(s: string, n = 120): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

/**
 * Best-effort one-line summary of a tool's args. Specialized for tools
 * we expect to see most often; falls back to a JSON excerpt for unknown
 * tools. Pure formatting; never throws.
 */
function summariseArgs(toolName: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  switch (toolName) {
    case 'read_file':
    case 'find_files':
    case 'get_ast_slice':
      return asString(args.path) || asString(args.pattern) || ''
    case 'find_symbol':
    case 'get_symbol':
      return asString(args.symbol) || asString(args.name) || ''
    case 'search_code':
    case 'grep_lines':
      return asString(args.query) || asString(args.pattern) || ''
    case 'replace_text':
    case 'replace_range':
    case 'apply_patch':
    case 'write_file':
      return asString(args.path) || ''
    case 'run_test':
    case 'run_command':
      return asString(args.command) || asString(args.testFilter) || ''
    case 'recommended_verification':
      return ''
    case 'finish_work_branch':
      return asString(args.message) || ''
    default:
      try {
        return truncate(JSON.stringify(args), 80)
      } catch {
        return ''
      }
  }
}

/** Best-effort one-line summary of a tool's output. */
function summariseOutput(toolName: string, payload: Record<string, unknown>): string {
  if (toolName === 'run_test' || toolName === 'run_command') {
    const passed = payload.passed
    const cmd = asString(payload.command)
    if (passed === true) return `✓ ${cmd}`
    if (passed === false) return `✗ ${cmd}`
    return cmd
  }
  if (toolName === 'recommended_verification') {
    const cmds = Array.isArray(payload.commands) ? payload.commands.length : 0
    return cmds ? `${cmds} suggested command${cmds === 1 ? '' : 's'}` : 'no test target found'
  }
  const text = asString(payload.summary) || asString(payload.text) || asString(payload.content)
  if (text) return truncate(text, 80)
  // Generic: success bool
  if (typeof payload.success === 'boolean') return payload.success ? '✓ ok' : '✗ failed'
  return ''
}

/**
 * Map a single audit event to a scene action. Returns null when the
 * event isn't something we want to animate (e.g. internal lifecycle).
 *
 * Keep the noisy events filtered out here — the theater is for the
 * narrative spine, not every breadcrumb.
 */
export function eventToScene(event: AuditEvent): SceneAction | null {
  const payload = asRecord(event.payload) ?? {}
  const at = event.created_at ?? event.occurred_at ?? new Date().toISOString()
  const id = event.id

  switch (event.kind) {
    case 'llm.call.completed': {
      const text = asString(payload.text) || asString(payload.content) || asString(payload.finalResponse) || ''
      const inputTokens = typeof payload.input_tokens === 'number' ? payload.input_tokens : 0
      const outputTokens = typeof payload.output_tokens === 'number' ? payload.output_tokens : 0
      const cost = typeof payload.estimated_cost === 'number' ? payload.estimated_cost : undefined
      return {
        id,
        kind: 'llm-speaks',
        actor: 'llm',
        at,
        preview: text ? truncate(text) : '(tool-only response)',
        tokens: { input: inputTokens, output: outputTokens, cost },
        raw: event,
      }
    }

    case 'tool.invocation.completed': {
      const toolName = asString(payload.tool_name) || asString(payload.toolName) || '?'
      // We emit BOTH a tool-call (showing the call going right) and a
      // tool-result (the response coming back). audit-gov collapses these
      // into one completed event, so we synthesise two scenes per event
      // with a tiny delta so the bubbles animate in sequence.
      // For Phase 1 we only emit the result side; the call side will be
      // synthesized in Phase 2 from llm.tool_call_started events.
      return {
        id,
        kind: 'tool-result',
        actor: 'agent',
        at,
        toolName,
        passed: typeof payload.passed === 'boolean' ? payload.passed : undefined,
        success: typeof payload.success === 'boolean' ? payload.success : undefined,
        summary: summariseOutput(toolName, payload),
        raw: event,
      }
    }

    case 'agent.phase.transitioned': {
      const phase = asString(payload.to_phase) || asString(payload.phase) || ''
      if (!phase) return null
      return { id, kind: 'phase-change', actor: 'system', at, phase, raw: event }
    }

    case 'code_change.applied':
    case 'code_change.detected': {
      const paths = Array.isArray(payload.paths_touched)
        ? (payload.paths_touched as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      const commitSha = asString(payload.commit_sha) || undefined
      return { id, kind: 'code-change', actor: 'agent', at, paths, commitSha, raw: event }
    }

    case 'agent_loop.formal_verification.fail':
    case 'agent_loop.formal_verification.ok':
    case 'blueprint.stage.run.completed': {
      const passed = event.kind !== 'agent_loop.formal_verification.fail'
      const reason = asString(payload.reason) || asString(payload.verdict) || undefined
      return { id, kind: 'finish', actor: 'agent', at, passed, reason, raw: event }
    }

    default:
      return null
  }
}

/**
 * Synthetic "tool-call" scene action derived from a tool-result event.
 * Phase 1 helper — Phase 2 will use the real `llm.tool_call_started`
 * event once we add that on the mcp-server side. For now, infer the
 * call from the result's args.
 */
export function deriveToolCallScene(toolResult: SceneAction): SceneAction | null {
  if (toolResult.kind !== 'tool-result') return null
  const raw = toolResult.raw as AuditEvent
  const payload = asRecord(raw.payload) ?? {}
  const args = asRecord(payload.args) ?? asRecord(payload.arguments) ?? null
  return {
    id: `${toolResult.id}-call`,
    kind: 'tool-call',
    actor: 'agent',
    at: toolResult.at,
    toolName: toolResult.toolName,
    argPreview: summariseArgs(toolResult.toolName, args),
    raw: toolResult.raw,
  }
}
