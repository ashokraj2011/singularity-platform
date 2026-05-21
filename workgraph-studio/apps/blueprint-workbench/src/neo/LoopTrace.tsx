/**
 * M45 — ReAct Loop visualizer for the Workbench.
 *
 * Renders the agent loop trace as:
 *   • a phase ribbon at the top (PLAN_DRAFT → EXPLORE → PLAN_CONFIRM → ACT → VERIFY → FINALIZE)
 *   • step-by-step cards below — one per LLM call — with prompt preview,
 *     response text, emitted tool calls, and the resulting tool invocations.
 *
 * Data comes from /blueprint/sessions/:id/stages/:stageKey/loop-trace which
 * proxies mcp-server's audit timeline. While the stage is RUNNING we poll
 * every 2.5s; otherwise we refetch only when the user manually requests it.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type LoopTraceResponse, type LoopTraceStep, type LoopTraceToolInvocation, type LoopStage, type LoopAttemptStatus } from '../api'

const KNOWN_PHASES = ['PLAN_DRAFT', 'EXPLORE', 'PLAN_CONFIRM', 'ACT', 'VERIFY', 'FINALIZE'] as const

const POLL_MS_RUNNING = 2500
const POLL_MS_IDLE = 30_000

interface LoopTraceProps {
  sessionId: string
  stage: LoopStage | undefined
  /** Latest attempt's status. When 'RUNNING', poll fast. */
  attemptStatus?: LoopAttemptStatus
}

export function LoopTrace({ sessionId, stage, attemptStatus }: LoopTraceProps) {
  const stageKey = stage?.key
  const isLive = attemptStatus === 'RUNNING' || attemptStatus === 'PENDING' || attemptStatus === 'PAUSED'

  const query = useQuery<LoopTraceResponse>({
    queryKey: ['loopTrace', sessionId, stageKey],
    queryFn: () => api.loopTrace(sessionId, stageKey!),
    enabled: Boolean(stageKey),
    refetchInterval: isLive ? POLL_MS_RUNNING : POLL_MS_IDLE,
    refetchOnWindowFocus: true,
  })

  const data = query.data

  // Group phases by name for the ribbon (multiple blocks of the same phase
  // are aggregated — useful when a run re-enters a phase via send-back).
  const phaseRibbon = useMemo(() => {
    const byPhase = new Map<string, { steps: number; tools: number; latestEndedAt: string }>()
    for (const p of data?.phases ?? []) {
      const cur = byPhase.get(p.phase) ?? { steps: 0, tools: 0, latestEndedAt: '' }
      cur.steps += p.llmCallCount
      cur.tools += p.toolInvocationCount
      if (p.endedAt > cur.latestEndedAt) cur.latestEndedAt = p.endedAt
      byPhase.set(p.phase, cur)
    }
    return KNOWN_PHASES.map((phase) => ({
      phase,
      ...(byPhase.get(phase) ?? { steps: 0, tools: 0, latestEndedAt: '' }),
      visited: byPhase.has(phase),
    }))
  }, [data?.phases])

  // Identify the current/most-recent phase for ribbon highlighting.
  const lastPhase = data?.steps[data.steps.length - 1]?.phase ?? null

  if (!stageKey) {
    return <div className="loop-trace-empty">Select a stage to view its agent loop.</div>
  }

  return (
    <div className="loop-trace">
      <header className="loop-trace-header">
        <div>
          <h3>Agent reasoning loop</h3>
          <p className="loop-trace-sub">{stage?.label ?? stageKey}</p>
        </div>
        <div className="loop-trace-summary">
          {data?.summary ? (
            <>
              <SummaryPill label="Steps" value={String(data.summary.totalSteps)} />
              <SummaryPill label="Tool calls" value={String(data.summary.totalToolInvocations)} />
              <SummaryPill label="Code changes" value={String(data.summary.totalCodeChanges)} />
              {data.summary.finishReason && (
                <SummaryPill label="Finished" value={data.summary.finishReason} tone={data.summary.finishReason === 'stop' ? 'ok' : 'warn'} />
              )}
              {isLive && <SummaryPill label="Live" value="●" tone="live" />}
            </>
          ) : query.isLoading ? (
            <SummaryPill label="Loading…" value="" />
          ) : query.isError ? (
            <SummaryPill label="Error" value={(query.error as Error).message.slice(0, 30)} tone="warn" />
          ) : null}
        </div>
      </header>

      <nav className="loop-phase-ribbon" aria-label="Loop phases">
        {phaseRibbon.map((p, i) => (
          <div
            key={p.phase}
            className={`loop-phase-pill${p.visited ? ' visited' : ''}${p.phase === lastPhase ? ' active' : ''}`}
            title={p.visited ? `${p.steps} LLM call${p.steps === 1 ? '' : 's'} • ${p.tools} tool call${p.tools === 1 ? '' : 's'}` : 'not yet reached'}
          >
            <span className="loop-phase-num">{i + 1}</span>
            <span className="loop-phase-name">{prettyPhaseName(p.phase)}</span>
            {p.visited && (
              <span className="loop-phase-meta">
                {p.steps} step{p.steps === 1 ? '' : 's'}{p.tools > 0 ? ` · ${p.tools} tool${p.tools === 1 ? '' : 's'}` : ''}
              </span>
            )}
          </div>
        ))}
      </nav>

      <section className="loop-steps">
        {(data?.steps ?? []).length === 0 && !query.isLoading && (
          <div className="loop-steps-empty">
            No activity yet. The trace will populate as the agent runs.
          </div>
        )}
        {(data?.steps ?? []).map((step) => (
          <StepCard key={step.llmCallId} step={step} />
        ))}
      </section>

      {data && data.summary.changedPaths.length > 0 && (
        <footer className="loop-trace-footer">
          <strong>Paths touched ({data.summary.changedPaths.length})</strong>
          <ul>
            {data.summary.changedPaths.map((p) => <li key={p}><code>{p}</code></li>)}
          </ul>
        </footer>
      )}
    </div>
  )
}

function SummaryPill({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'live' }) {
  return (
    <span className={`loop-summary-pill${tone ? ` ${tone}` : ''}`}>
      <span className="loop-summary-label">{label}</span>
      {value && <span className="loop-summary-value">{value}</span>}
    </span>
  )
}

function StepCard({ step }: { step: LoopTraceStep }) {
  const [expanded, setExpanded] = useState(false)
  const phase = step.phase ? prettyPhaseName(step.phase) : '—'
  const time = new Date(step.timestamp).toLocaleTimeString()
  const hasError = step.finishReason === 'error' || Boolean(step.error)
  return (
    <article className={`loop-step-card${hasError ? ' error' : ''}`}>
      <header className="loop-step-header" onClick={() => setExpanded((e) => !e)} role="button" tabIndex={0}>
        <div className="loop-step-left">
          <span className="loop-step-index">#{step.stepIndex ?? '?'}</span>
          <span className={`loop-step-phase phase-${(step.phase ?? 'unknown').toLowerCase()}`}>{phase}</span>
        </div>
        <div className="loop-step-meta">
          <span>{step.model.alias ?? step.model.model}</span>
          <span>{step.tokens.input} in · {step.tokens.output} out</span>
          <span>{step.latencyMs} ms</span>
          <span>{time}</span>
          <span className="loop-step-expand">{expanded ? '▾' : '▸'}</span>
        </div>
      </header>

      {step.responseText && (
        <div className="loop-step-response">
          <strong>Assistant said:</strong>
          <pre>{step.responseText}</pre>
        </div>
      )}

      {step.responseToolCalls.length > 0 && (
        <div className="loop-step-toolcalls">
          <strong>Emitted tool calls:</strong>
          <ul>
            {step.responseToolCalls.map((tc, i) => (
              <li key={i}><code>{tc.name}</code>{tc.args_preview ? <span> ({tc.args_preview})</span> : null}</li>
            ))}
          </ul>
        </div>
      )}

      {step.toolInvocations.length > 0 && (
        <div className="loop-step-tool-results">
          {step.toolInvocations.map((t) => <ToolInvocationBlock key={t.id} tool={t} expanded={expanded} />)}
        </div>
      )}

      {expanded && step.promptPreview.length > 0 && (
        <div className="loop-step-prompt">
          <strong>Prompt preview ({step.promptPreview.length} messages)</strong>
          <ol>
            {step.promptPreview.map((m, i) => (
              <li key={i}>
                <span className={`prompt-role role-${m.role}`}>{m.role}</span>
                {m.tool_name && <span className="prompt-toolname"> · {m.tool_name}</span>}
                <span className="prompt-content">{m.content_preview}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {step.error && (
        <div className="loop-step-error">
          <strong>Error:</strong> <span>{step.error}</span>
        </div>
      )}
    </article>
  )
}

function ToolInvocationBlock({ tool, expanded }: { tool: LoopTraceToolInvocation; expanded: boolean }) {
  const outputStr = useMemo(() => {
    try { return JSON.stringify(tool.output, null, 2) } catch { return String(tool.output) }
  }, [tool.output])
  const argsStr = useMemo(() => {
    try { return JSON.stringify(tool.args, null, 2) } catch { return String(tool.args) }
  }, [tool.args])
  return (
    <div className={`loop-tool-invocation${tool.success ? '' : ' failed'}`}>
      <div className="loop-tool-head">
        <code className="loop-tool-name">{tool.name}</code>
        <span className={`loop-tool-status${tool.success ? ' ok' : ' err'}`}>
          {tool.success ? '✓' : '✗'} {tool.latencyMs} ms
        </span>
      </div>
      {!tool.success && tool.error && (
        <div className="loop-tool-error">
          {tool.error_code ? <span className="error-code">{tool.error_code}</span> : null}
          <span>{tool.error}</span>
        </div>
      )}
      {expanded && (
        <details className="loop-tool-details" open={!tool.success}>
          <summary>args / output</summary>
          <div className="loop-tool-args"><strong>args</strong><pre>{argsStr}</pre></div>
          <div className="loop-tool-output"><strong>output</strong><pre>{outputStr.slice(0, 3000)}{outputStr.length > 3000 ? `\n…[${outputStr.length - 3000} more chars]` : ''}</pre></div>
        </details>
      )}
    </div>
  )
}

function prettyPhaseName(phase: string): string {
  switch (phase) {
    case 'PLAN_DRAFT': return 'Plan Draft'
    case 'EXPLORE': return 'Explore'
    case 'PLAN_CONFIRM': return 'Plan Confirm'
    case 'ACT': return 'Act'
    case 'VERIFY': return 'Verify'
    case 'FINALIZE': return 'Finalize'
    default: return phase
  }
}
