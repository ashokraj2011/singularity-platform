/**
 * Loop-trace synthesizer (2026-05-27 rewire).
 *
 * Reads governed-loop events from audit-gov by trace_id and synthesizes the
 * LoopTraceResponse shape that the workbench's LoopTrace component expects.
 *
 * Background: pre-M71 the agent loop ran in mcp-server, which wrote
 * LlmCallRecord rows into its own in-process audit store. The workbench's
 * /loop-trace endpoint proxied to mcp-server's /mcp/audit/loop-trace and
 * everything just worked. Post-M71 the loop moved to context-fabric, which
 * emits `governed.llm_request` / `governed.llm_response` / `governed.tool_dispatched`
 * events into audit-gov. mcp-server's store has no data for new runs, so
 * the workbench's "Loop trace" tab + the M83.t "thinking →" chip + the
 * M83.r "Deep reasoning" section all show empty for governed runs.
 *
 * This module fixes that by pulling events from audit-gov and reshaping
 * them. The wire format matches the legacy mcp-server response 1:1 so the
 * UI needs no changes beyond the new thinking_blocks field (already added
 * to LoopTraceStep in M83.r).
 *
 * Event correlation: each LLM round-trip emits one `governed.llm_request`
 * followed by one `governed.llm_response`. We pair them in event order
 * within a trace, then attach any `governed.tool_dispatched` events that
 * fire between the response and the next request (those are tools the
 * agent emitted in that round).
 */
import { postJson } from '../../lib/audit-gov/client'

// ─── Audit-gov event shapes ────────────────────────────────────────────────

interface AuditEvent {
  id: string
  trace_id: string | null
  source_service: string
  kind: string
  subject_type: string | null
  subject_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

interface SearchResponse {
  items: AuditEvent[]
  nextCursor: string | null
}

// ─── Output shapes (match LoopTraceResponse in workbench's api.ts) ─────────

interface LoopTracePromptMessage {
  role: string
  content_preview: string
  tool_call_id?: string
  tool_name?: string
}

interface LoopTraceToolInvocation {
  id: string
  toolName: string
  args: unknown
  output: unknown
  success: boolean
  error?: string | null
  latencyMs: number
  timestamp: string
}

interface LoopTraceStep {
  llmCallId: string
  stepIndex: number | null
  phase: string | null
  model: { provider: string; model: string; alias: string | null }
  tokens: { input: number; output: number; thinking?: number }
  finishReason: 'stop' | 'tool_call' | 'length' | 'error'
  latencyMs: number
  timestamp: string
  promptPreview: LoopTracePromptMessage[]
  responseText: string | null
  responseToolCalls: Array<{ name: string; args_preview: string }>
  toolInvocations: LoopTraceToolInvocation[]
  error?: string | null
  thinkingBlocks?: Array<{ thinking: string; signature?: string; redacted?: boolean }>
}

interface LoopTracePhaseBlock {
  phase: string
  startStepIndex: number | null
  endStepIndex: number | null
  llmCallCount: number
  toolInvocationCount: number
  startedAt: string
  endedAt: string
}

// M89.b — Governance events extracted alongside the LLM steps.
// These are the per-phase signals operators most care about when a
// stage failed: did a phase complete cleanly, did the validator
// reject a receipt, did the budget warning fire, etc. Each event
// carries the stepIndex of the LLM call it follows (or null if the
// event landed before any step) so the UI can render it inline.
//
// Wire format kept intentionally narrow — we only forward fields the
// workbench needs to display. The raw audit event remains in
// audit-gov for deeper inspection.
export type LoopTraceGovEventKind =
  | 'phase_completed'
  | 'phase_output_invalid'
  | 'phase_budget_exceeded'
  | 'path_coverage_gap'
  | 'auto_verify_completed'

export interface LoopTraceGovernanceEvent {
  kind: LoopTraceGovEventKind
  phase: string | null
  timestamp: string
  /** Closest preceding step (null if event landed before any LLM call). */
  stepIndex: number | null
  /** Free-form details for hover/expanded view — never null, always populated. */
  details: {
    reason?: string
    missingFields?: string[]
    budget?: number
    turnsInPhase?: number
    uncoveredCount?: number
  }
}

export interface LoopTraceResponse {
  traceId: string
  phases: LoopTracePhaseBlock[]
  steps: LoopTraceStep[]
  /** M89.b — see LoopTraceGovernanceEvent. */
  governanceEvents: LoopTraceGovernanceEvent[]
  summary: {
    totalSteps: number
    totalLlmCalls: number
    totalToolInvocations: number
    totalCodeChanges: number
    changedPaths: string[]
    firstStepAt?: string | null
    lastStepAt?: string | null
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pickString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function pickNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function pickPhase(payload: Record<string, unknown>): string | null {
  const gov = asRecord(payload.governance)
  return pickString(gov, 'current_phase') ?? null
}

function argsPreview(args: unknown): string {
  if (!args) return ''
  try {
    const s = JSON.stringify(args)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return String(args).slice(0, 200)
  }
}

// ─── Synthesizer ───────────────────────────────────────────────────────────

/**
 * Query audit-gov for all governed-loop events in a trace and reshape
 * them into the LoopTraceResponse the UI expects. Returns the empty
 * shell when audit-gov is unreachable or the trace has no events.
 */
export async function synthesizeLoopTrace(traceId: string): Promise<LoopTraceResponse> {
  const empty: LoopTraceResponse = {
    traceId,
    phases: [],
    steps: [],
    governanceEvents: [],
    summary: {
      totalSteps: 0, totalLlmCalls: 0, totalToolInvocations: 0,
      totalCodeChanges: 0, changedPaths: [],
    },
  }

  const result = await postJson<SearchResponse>('/api/v1/audit/search', {
    traceId,
    kinds: [
      'governed.llm_request',
      'governed.llm_response',
      'governed.tool_dispatched',
      'governed.tool_dispatched_via_laptop',
      'governed.tool_refused',
      'governed.tool_dispatch_failed',
      // M89.b — governance events surfaced as a separate timeline
      // strip in the workbench. See LoopTraceGovernanceEvent above.
      'governed.phase_completed',
      'governed.phase_output_invalid',
      'governed.phase_budget_exceeded',
      'governed.path_coverage_gap',
      'governed.auto_verify_completed',
    ],
    limit: 500,
  })
  if (!result || !Array.isArray(result.items) || result.items.length === 0) {
    return empty
  }

  // audit-gov returns DESC; flip to chronological so step ordering matches
  // what the operator saw happen.
  const events = [...result.items].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  )

  // Pair requests with responses in order. tool_dispatched events that
  // fall between a response and the next request belong to that step
  // (they're the tools the agent emitted from that response).
  const steps: LoopTraceStep[] = []
  const governanceEvents: LoopTraceGovernanceEvent[] = []
  let pendingRequest: AuditEvent | null = null
  let stepIndex = 0
  // Map audit `kind` → narrow LoopTraceGovEventKind for the workbench wire.
  const GOV_EVENT_MAP: Record<string, LoopTraceGovEventKind> = {
    'governed.phase_completed': 'phase_completed',
    'governed.phase_output_invalid': 'phase_output_invalid',
    'governed.phase_budget_exceeded': 'phase_budget_exceeded',
    'governed.path_coverage_gap': 'path_coverage_gap',
    'governed.auto_verify_completed': 'auto_verify_completed',
  }
  for (const evt of events) {
    // M89.b — peel off governance events first; they don't affect step
    // pairing but get rendered inline by the workbench.
    const govKind = GOV_EVENT_MAP[evt.kind]
    if (govKind) {
      const p = asRecord(evt.payload)
      const details: LoopTraceGovernanceEvent['details'] = {}
      const reason = pickString(p, 'reason')
      if (reason) details.reason = reason
      const detailArr = Array.isArray(p.details) ? p.details : []
      const missing = detailArr
        .map((d) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).field : null))
        .filter((f): f is string => typeof f === 'string')
      if (missing.length > 0) details.missingFields = missing
      const budget = p.budget
      if (typeof budget === 'number') details.budget = budget
      const tinp = p.turns_in_phase
      if (typeof tinp === 'number') details.turnsInPhase = tinp
      const uncov = Array.isArray(p.uncovered)
        ? p.uncovered
        : Array.isArray(p.uncovered_files) ? p.uncovered_files : null
      if (uncov) details.uncoveredCount = uncov.length
      governanceEvents.push({
        kind: govKind,
        phase: pickPhase(p),
        timestamp: evt.created_at,
        // stepIndex = the last LLM step we've finished pairing. If we
        // haven't seen any step yet (event before turn 0), this is null.
        stepIndex: steps.length > 0 ? steps[steps.length - 1].stepIndex : null,
        details,
      })
      continue
    }
    if (evt.kind === 'governed.llm_request') {
      pendingRequest = evt
      continue
    }
    if (evt.kind === 'governed.llm_response') {
      const reqPayload = asRecord(pendingRequest?.payload)
      const respPayload = asRecord(evt.payload)
      const phase = pickPhase(respPayload) ?? pickPhase(reqPayload)
      const toolCallsRaw = Array.isArray(respPayload.tool_calls) ? respPayload.tool_calls : []
      const thinkingRaw = Array.isArray(respPayload.thinking_blocks) ? respPayload.thinking_blocks : []

      const step: LoopTraceStep = {
        llmCallId: evt.id,
        stepIndex,
        phase,
        model: {
          provider: pickString(respPayload, 'provider') ?? 'unknown',
          model: pickString(respPayload, 'model') ?? '',
          alias: pickString(respPayload, 'model_alias') ?? null,
        },
        tokens: {
          input: pickNumber(respPayload, 'input_tokens'),
          output: pickNumber(respPayload, 'output_tokens'),
          thinking: pickNumber(respPayload, 'thinking_tokens'),
        },
        finishReason: (pickString(respPayload, 'finish_reason') ?? 'stop') as LoopTraceStep['finishReason'],
        latencyMs: pickNumber(respPayload, 'latency_ms'),
        timestamp: evt.created_at,
        // (2026-05-31) The governed.llm_request event now carries the full
        // composed `messages` array (context-fabric, gated by
        // CF_CAPTURE_FULL_PROMPT, default on). Render the ENTIRE prompt —
        // uncapped per operator choice — so the Loop tab's "Full prompt sent"
        // panel shows exactly what each phase sent to the model.
        promptPreview: (Array.isArray(reqPayload.messages) ? reqPayload.messages : [])
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .map(m => {
            const c = (m as Record<string, unknown>).content
            const content = typeof c === 'string' ? c : JSON.stringify(c, null, 2)
            return {
              role: pickString(m, 'role') ?? 'unknown',
              content_preview: content,
              tool_call_id: pickString(m, 'tool_call_id'),
              tool_name: pickString(m, 'tool_name') ?? pickString(m, 'name'),
            }
          }),
        responseText: pickString(respPayload, 'content') ?? null,
        responseToolCalls: toolCallsRaw
          .filter((tc): tc is Record<string, unknown> => typeof tc === 'object' && tc !== null)
          .map(tc => ({
            name: pickString(tc, 'name') ?? '',
            args_preview: argsPreview(tc.args ?? tc.arguments),
          })),
        toolInvocations: [], // populated below from tool_dispatched events
        thinkingBlocks: thinkingRaw
          .filter((tb): tb is Record<string, unknown> => typeof tb === 'object' && tb !== null)
          .map(tb => ({
            thinking: pickString(tb, 'thinking') ?? '',
            redacted: tb.redacted === true,
          })),
      }
      steps.push(step)
      pendingRequest = null
      stepIndex++
      continue
    }
    // Tool events attach to the most recent step (the one that emitted them).
    if (
      evt.kind === 'governed.tool_dispatched'
      || evt.kind === 'governed.tool_dispatched_via_laptop'
      || evt.kind === 'governed.tool_refused'
      || evt.kind === 'governed.tool_dispatch_failed'
    ) {
      const current = steps[steps.length - 1]
      if (!current) continue
      const p = asRecord(evt.payload)
      const refused = evt.kind === 'governed.tool_refused'
      const failed = evt.kind === 'governed.tool_dispatch_failed'
      current.toolInvocations.push({
        id: pickString(p, 'tool_invocation_id') ?? evt.id,
        toolName: pickString(p, 'tool_name') ?? '<unknown>',
        args: p.args ?? null,
        output: p.result ?? null,
        success: !refused && !failed && p.tool_success !== false,
        error: refused
          ? (pickString(p, 'reason') ?? 'tool refused')
          : failed
            ? (pickString(p, 'error') ?? 'dispatch failed')
            : (pickString(p, 'tool_error') ?? null),
        latencyMs: pickNumber(p, 'duration_ms'),
        timestamp: evt.created_at,
      })
    }
  }

  // Phase summary: collapse consecutive same-phase steps into one block.
  const phaseBlocks: LoopTracePhaseBlock[] = []
  for (const s of steps) {
    if (!s.phase) continue
    const last = phaseBlocks[phaseBlocks.length - 1]
    if (last && last.phase === s.phase) {
      last.endStepIndex = s.stepIndex
      last.llmCallCount += 1
      last.toolInvocationCount += s.toolInvocations.length
      last.endedAt = s.timestamp
    } else {
      phaseBlocks.push({
        phase: s.phase,
        startStepIndex: s.stepIndex,
        endStepIndex: s.stepIndex,
        llmCallCount: 1,
        toolInvocationCount: s.toolInvocations.length,
        startedAt: s.timestamp,
        endedAt: s.timestamp,
      })
    }
  }

  return {
    traceId,
    phases: phaseBlocks,
    steps,
    governanceEvents,
    summary: {
      totalSteps: steps.length,
      totalLlmCalls: steps.length,
      totalToolInvocations: steps.reduce((n, s) => n + s.toolInvocations.length, 0),
      totalCodeChanges: 0,            // tracked elsewhere via CodeChange.byCfCallId
      changedPaths: [],
      firstStepAt: steps[0]?.timestamp ?? null,
      lastStepAt: steps[steps.length - 1]?.timestamp ?? null,
    },
  }
}
