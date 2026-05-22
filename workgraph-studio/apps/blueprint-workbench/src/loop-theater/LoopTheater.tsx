/**
 * M69 Loop Theater — Phase 1 skeleton.
 *
 * Goal of Phase 1: prove the data flow. Renders a raw, lightly-styled
 * list of scene actions as the pacer reveals them. No animation yet
 * (Phase 2), no detail drawer (Phase 3). Just enough to verify
 *   browser → vite proxy → audit-gov → eventToScene → DOM
 * works end-to-end against a real RuleEngine trace.
 *
 * Entry: rendered by App.tsx when `?theater=<traceIdPrefix>` is in the
 * URL. Replaces the normal workbench shell for that session.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Activity, Brain, Bot, CheckCircle2, GitCommit, Wrench, XCircle } from 'lucide-react'
import { useLiveLoopEventStream } from './useLiveLoopEventStream'
import type { SceneAction } from './eventToScene'

interface LoopTheaterProps {
  traceIdPrefix: string
  /** When true, the theater takes the full viewport. Used by the
   * standalone ?theater=... URL mount in main.tsx. When false (default),
   * the theater fits its container — used by the Theater tab inside the
   * workbench, where NeoOverlayShell controls the height. */
  standalone?: boolean
}

export function LoopTheater({ traceIdPrefix, standalone = false }: LoopTheaterProps) {
  const { scenes, status, error } = useLiveLoopEventStream({ traceIdPrefix })
  const phases = useMemo(() => collectPhases(scenes), [scenes])
  const totalCost = useMemo(() => sumCost(scenes), [scenes])

  // Auto-scroll the bubble column to the latest scene as new events
  // arrive. Without this the user has to chase the action manually,
  // which kills the "live, watch the agent work" feel.
  const bubblesRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = bubblesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [scenes.length])

  return (
    <div className={`loop-theater${standalone ? ' loop-theater--standalone' : ''}`}>
      <header className="loop-theater__header">
        <div className="loop-theater__title">
          <Activity size={18} />
          <span>Loop Theater · how the agent did this run</span>
        </div>
        <div className="loop-theater__meta">
          <span>trace: <code>{traceIdPrefix}</code></span>
          <span>scenes: {scenes.length}</span>
          <span>cost: ${totalCost.toFixed(4)}</span>
          <span className={`loop-theater__status loop-theater__status--${status}`}>
            {status === 'live' ? '● live' : status === 'reconnecting' ? '○ reconnecting…' : status === 'connecting' ? '○ connecting…' : '○ closed'}
          </span>
        </div>
      </header>

      {phases.length > 0 && (
        <div className="loop-theater__phases">
          {phases.map((p, i) => (
            <span key={i} className="loop-theater__phase-chip">
              {p}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="loop-theater__error">
          <XCircle size={16} /> {error}
        </div>
      )}

      <div className="loop-theater__stage">
        <div className="loop-theater__column loop-theater__column--llm">
          <div className="loop-theater__character">
            <Brain size={28} />
            <strong>LLM</strong>
            <span>Claude Haiku 4.5</span>
          </div>
        </div>

        <div className="loop-theater__column loop-theater__column--bubbles" ref={bubblesRef}>
          {scenes.length === 0 && (
            <div className="loop-theater__empty">
              {status === 'live'
                ? 'Connected. No activity yet for this session — start or resume a stage and the conversation will appear here.'
                : status === 'connecting' || status === 'reconnecting'
                  ? 'Loading recent activity and connecting to the live stream…'
                  : 'Stream closed.'}
            </div>
          )}
          {scenes.map((scene) => (
            <SceneRow key={scene.id} scene={scene} />
          ))}
        </div>

        <div className="loop-theater__column loop-theater__column--agent">
          <div className="loop-theater__character">
            <Bot size={28} />
            <strong>Agent</strong>
            <span>mcp-server</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SceneRow({ scene }: { scene: SceneAction }) {
  switch (scene.kind) {
    case 'llm-speaks':
      return (
        <div className="loop-theater__row loop-theater__row--llm">
          <div className="loop-theater__bubble loop-theater__bubble--llm">
            <div className="loop-theater__bubble-text">{scene.preview}</div>
            {scene.tokens && (scene.tokens.input > 0 || scene.tokens.output > 0) && (
              <div className="loop-theater__bubble-meta">
                {scene.tokens.input}in / {scene.tokens.output}out
                {scene.tokens.cost !== undefined && ` · $${scene.tokens.cost.toFixed(4)}`}
              </div>
            )}
          </div>
        </div>
      )
    case 'tool-call':
      // The narrative IS the message ("Let me read Operator.java"). The
      // tool name moves to a small chip below so a debugger can still
      // see what fired without making the bubble look like a function
      // call signature.
      return (
        <div className="loop-theater__row loop-theater__row--agent">
          <div className="loop-theater__bubble loop-theater__bubble--call">
            <div className="loop-theater__bubble-text">
              <Wrench size={11} /> {scene.argPreview || `Using ${scene.toolName}`}
            </div>
            <div className="loop-theater__bubble-meta">{scene.toolName}</div>
          </div>
        </div>
      )
    case 'tool-result': {
      const isOk = scene.passed === true || scene.success === true
      const isFail = scene.passed === false || scene.success === false
      return (
        <div className="loop-theater__row loop-theater__row--agent">
          <div className={`loop-theater__bubble loop-theater__bubble--result${isFail ? ' fail' : ''}`}>
            <div className="loop-theater__bubble-text">
              {isOk
                ? <CheckCircle2 size={11} color="#86c79f" />
                : isFail
                  ? <XCircle size={11} color="#e57373" />
                  : <CheckCircle2 size={11} color="#7c87a3" />}{' '}
              {scene.summary || 'Done'}
            </div>
          </div>
        </div>
      )
    }
    case 'phase-change':
      // Phase changes mark beats in the conversation. Lighter touch so
      // they don't dominate the eye like a tool result.
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className="loop-theater__bubble loop-theater__bubble--phase">
            entering {scene.phase.toLowerCase()} phase
          </div>
        </div>
      )
    case 'code-change':
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className="loop-theater__bubble loop-theater__bubble--code">
            <GitCommit size={12} /> {scene.paths.length > 0
              ? `Committed ${scene.paths.length} file${scene.paths.length === 1 ? '' : 's'}`
              : 'Committed the change'}
            {scene.commitSha && (
              <span className="loop-theater__bubble-meta-inline">{scene.commitSha.slice(0, 8)}</span>
            )}
          </div>
        </div>
      )
    case 'finish':
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className={`loop-theater__bubble loop-theater__bubble--finish ${scene.passed ? 'ok' : 'fail'}`}>
            {scene.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{' '}
            {scene.passed
              ? 'Finished — the change is in'
              : `Blocked${scene.reason ? `: ${scene.reason}` : ''}`}
          </div>
        </div>
      )
    default:
      return null
  }
}

function collectPhases(scenes: SceneAction[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of scenes) {
    if (s.kind === 'phase-change' && !seen.has(s.phase)) {
      seen.add(s.phase)
      out.push(s.phase)
    }
  }
  return out
}

function sumCost(scenes: SceneAction[]): number {
  return scenes.reduce((total, s) => {
    if (s.kind === 'llm-speaks' && s.tokens?.cost) return total + s.tokens.cost
    return total
  }, 0)
}
