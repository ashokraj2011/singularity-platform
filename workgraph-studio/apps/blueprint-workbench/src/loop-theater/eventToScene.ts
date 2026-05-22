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
 * Render the agent's tool call as something a human would say. The goal
 * is conversational legibility ("Let me read Operator.java") not
 * machine-speak ("read_file(path=Operator.java)"). Falls back to the
 * tool name when args aren't shaped how we expect.
 *
 * Keeping these strings in code (not a translations file) because they
 * need to evolve with the tool registry and stay co-located with the
 * tool-name switch in summariseOutput below.
 */
function narrateToolCall(toolName: string, args: Record<string, unknown> | null): string {
  const path = args ? (asString(args.path) || asString(args.pattern)) : ''
  const filename = path ? path.split('/').pop() || path : ''

  switch (toolName) {
    case 'repo_map':            return 'Let me map out the repo to see the shape of the codebase'
    case 'index_workspace':     return 'Indexing the workspace so I can search it'
    case 'list_indexed_files':  return 'Checking which files are indexed'
    case 'list_directory': {
      const dir = path ? path : 'the project root'
      return `Listing ${dir}`
    }
    case 'find_files': {
      const pat = args ? asString(args.pattern) || asString(args.query) : ''
      return pat ? `Looking for files matching "${pat}"` : 'Looking for files'
    }
    case 'read_file':
      return filename ? `Reading ${filename}` : 'Reading a file'
    case 'get_ast_slice':
      return filename ? `Examining the structure of ${filename}` : 'Examining file structure'
    case 'find_symbol': {
      const sym = args ? asString(args.symbol) || asString(args.name) : ''
      return sym ? `Looking up the symbol "${sym}"` : 'Looking up a symbol'
    }
    case 'get_symbol': {
      const sym = args ? asString(args.symbol) || asString(args.name) : ''
      return sym ? `Reading the definition of ${sym}` : 'Reading a symbol definition'
    }
    case 'search_code':
    case 'grep_lines': {
      const q = args ? asString(args.query) || asString(args.pattern) : ''
      return q ? `Searching the code for "${q}"` : 'Searching the code'
    }
    case 'replace_text':
    case 'replace_range':
      return filename ? `Editing ${filename}` : 'Editing a file'
    case 'apply_patch':
      return filename ? `Applying a patch to ${filename}` : 'Applying a patch'
    case 'write_file':
      return filename ? `Writing ${filename}` : 'Writing a file'
    case 'recommended_verification':
      return 'Checking which test or lint command applies to this change'
    case 'run_test': {
      const cmd = args ? asString(args.command) || asString(args.testFilter) : ''
      return cmd ? `Running the tests: ${truncate(cmd, 60)}` : 'Running the tests'
    }
    case 'run_command': {
      const cmd = args ? asString(args.command) : ''
      return cmd ? `Running: ${truncate(cmd, 60)}` : 'Running a command'
    }
    case 'verification_unavailable':
      return 'Acknowledging that no test target exists for this change'
    case 'finish_work_branch':
      return 'Wrapping up — committing the work branch'
    case 'prepare_work_branch':
      return 'Setting up a working branch for this change'
    case 'git_commit':
      return 'Committing the change'
    case 'formal_verify':
      return 'Asking the formal verifier to prove the policy holds'
    default:
      return `Using ${toolName}`
  }
}

/**
 * Render the tool's result as a reply. Keep it short — these are reply
 * bubbles, not full payload dumps. Prefer success/failure phrasing
 * over raw output blobs (which go in the Phase 3 detail drawer).
 */
function narrateToolResult(toolName: string, payload: Record<string, unknown>): string {
  const success = payload.success
  const passed = payload.passed

  // Hard-fail signals first
  if (success === false || passed === false) {
    switch (toolName) {
      case 'list_directory':
      case 'read_file':
      case 'find_files':
        return "Couldn't find that"
      case 'run_test':
      case 'run_command':
        return 'The test failed'
      case 'find_symbol':
      case 'get_symbol':
        return "Couldn't find that symbol"
      default:
        return "That didn't work"
    }
  }

  switch (toolName) {
    case 'repo_map':
    case 'index_workspace': {
      const fc = typeof payload.file_count === 'number' ? payload.file_count
        : typeof payload.indexed_files === 'number' ? payload.indexed_files
        : null
      return fc != null ? `Got it — ${fc} files` : 'Done'
    }
    case 'list_directory': {
      const items = Array.isArray(payload.entries) ? payload.entries.length
        : typeof payload.count === 'number' ? payload.count : null
      return items != null ? `Found ${items} item${items === 1 ? '' : 's'}` : 'Got the listing'
    }
    case 'find_files': {
      const n = Array.isArray(payload.files) ? payload.files.length
        : Array.isArray(payload.matches) ? payload.matches.length : null
      return n != null ? `Found ${n} file${n === 1 ? '' : 's'}` : 'Got the matches'
    }
    case 'read_file':
      return 'Read it'
    case 'get_ast_slice':
      return 'Got the structure'
    case 'find_symbol':
    case 'get_symbol':
      return 'Found it'
    case 'search_code':
    case 'grep_lines': {
      const n = Array.isArray(payload.matches) ? payload.matches.length
        : Array.isArray(payload.results) ? payload.results.length : null
      return n != null ? `${n} match${n === 1 ? '' : 'es'}` : 'Done searching'
    }
    case 'replace_text':
    case 'replace_range':
    case 'write_file':
    case 'apply_patch':
      return 'Edit applied'
    case 'recommended_verification': {
      const cmds = Array.isArray(payload.commands) ? payload.commands.length : 0
      return cmds ? `${cmds} command${cmds === 1 ? '' : 's'} suggested` : 'No test target detected'
    }
    case 'run_test':
    case 'run_command':
      return passed === true ? 'Tests passed' : 'Done'
    case 'verification_unavailable':
      return 'Noted'
    case 'finish_work_branch':
      return 'Committed'
    case 'git_commit':
      return 'Commit recorded'
    case 'formal_verify': {
      const r = asString(payload.result).toUpperCase()
      return r === 'UNSAT' ? 'Policy holds' : r === 'SAT' ? 'Policy violation found' : 'Verifier done'
    }
    default:
      return 'Done'
  }
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
      // Skip the bubble entirely when the LLM only emitted tool calls —
      // the agent-side tool-call bubble will tell that story. Showing a
      // blank "(tool-only response)" bubble each turn was noise.
      if (!text.trim()) return null
      return {
        id,
        kind: 'llm-speaks',
        actor: 'llm',
        at,
        preview: truncate(text, 240),
        tokens: { input: inputTokens, output: outputTokens, cost },
        raw: event,
      }
    }

    case 'tool.invocation.completed': {
      const toolName = asString(payload.tool_name) || asString(payload.toolName) || '?'
      // Phase 1 collapses call+result into one tool-result event because
      // audit-gov stores them that way. The pacer in useLoopEventStream
      // synthesises a tool-call bubble (using deriveToolCallScene) for
      // the visual ping-pong; this branch produces the result.
      return {
        id,
        kind: 'tool-result',
        actor: 'agent',
        at,
        toolName,
        passed: typeof payload.passed === 'boolean' ? payload.passed : undefined,
        success: typeof payload.success === 'boolean' ? payload.success : undefined,
        summary: narrateToolResult(toolName, payload),
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
  // Tool args can land at different paths in the audit payload depending
  // on the originating service. Cover the common ones; fall back to a
  // best-effort scan of top-level scalar/string fields.
  const args = asRecord(payload.args)
    ?? asRecord(payload.arguments)
    ?? asRecord(payload.tool_args)
    ?? asRecord(payload.toolArgs)
    ?? payload  // command.ts spreads args at top level
  return {
    id: `${toolResult.id}-call`,
    kind: 'tool-call',
    actor: 'agent',
    at: toolResult.at,
    toolName: toolResult.toolName,
    argPreview: narrateToolCall(toolResult.toolName, args),
    raw: toolResult.raw,
  }
}
