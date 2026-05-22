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
import { useMemo } from 'react'
import { Activity, Brain, Bot, CheckCircle2, GitCommit, Sparkles, Wrench, XCircle } from 'lucide-react'
import { useLoopEventStream } from './useLoopEventStream'
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
  const { scenes, totalScenes, loading, error, done } = useLoopEventStream({
    traceIdPrefix,
    stepDelayMs: 220,
    paced: true,
  })

  const phases = useMemo(() => collectPhases(scenes), [scenes])
  const totalCost = useMemo(() => sumCost(scenes), [scenes])

  return (
    <div className={`loop-theater${standalone ? ' loop-theater--standalone' : ''}`}>
      <header className="loop-theater__header">
        <div className="loop-theater__title">
          <Activity size={18} />
          <span>Loop Theater · how the agent did this run</span>
        </div>
        <div className="loop-theater__meta">
          <span>trace: <code>{traceIdPrefix}</code></span>
          <span>scenes: {scenes.length}/{totalScenes}</span>
          <span>cost: ${totalCost.toFixed(4)}</span>
          <span className={done ? 'loop-theater__status loop-theater__status--done' : 'loop-theater__status'}>
            {loading ? 'loading…' : done ? 'replay complete' : 'replaying…'}
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

        <div className="loop-theater__column loop-theater__column--bubbles">
          {scenes.length === 0 && !loading && (
            <div className="loop-theater__empty">
              No scenes yet. Make sure FORMAL_VERIFICATION events have started — or check the trace ID matches a real run.
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
            <Sparkles size={12} /> {scene.preview}
            {scene.tokens && (
              <span className="loop-theater__tokens">
                {scene.tokens.input}in / {scene.tokens.output}out
                {scene.tokens.cost !== undefined && ` · $${scene.tokens.cost.toFixed(4)}`}
              </span>
            )}
          </div>
        </div>
      )
    case 'tool-call':
      return (
        <div className="loop-theater__row loop-theater__row--agent">
          <div className="loop-theater__bubble loop-theater__bubble--call">
            <Wrench size={12} /> <strong>{scene.toolName}</strong>
            {scene.argPreview && <span className="loop-theater__args">  {scene.argPreview}</span>}
          </div>
        </div>
      )
    case 'tool-result':
      return (
        <div className="loop-theater__row loop-theater__row--agent">
          <div className="loop-theater__bubble loop-theater__bubble--result">
            {scene.passed === true || scene.success === true ? (
              <CheckCircle2 size={12} color="#86c79f" />
            ) : scene.passed === false || scene.success === false ? (
              <XCircle size={12} color="#e57373" />
            ) : (
              <CheckCircle2 size={12} color="#7c87a3" />
            )}{' '}
            {scene.toolName} {scene.summary && <span className="loop-theater__args">→ {scene.summary}</span>}
          </div>
        </div>
      )
    case 'phase-change':
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className="loop-theater__bubble loop-theater__bubble--phase">
            phase → {scene.phase}
          </div>
        </div>
      )
    case 'code-change':
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className="loop-theater__bubble loop-theater__bubble--code">
            <GitCommit size={12} /> code committed
            {scene.commitSha && (
              <span className="loop-theater__args">  {scene.commitSha.slice(0, 8)}</span>
            )}
            {scene.paths.length > 0 && (
              <span className="loop-theater__args">  ({scene.paths.length} file{scene.paths.length === 1 ? '' : 's'})</span>
            )}
          </div>
        </div>
      )
    case 'finish':
      return (
        <div className="loop-theater__row loop-theater__row--system">
          <div className={`loop-theater__bubble loop-theater__bubble--finish ${scene.passed ? 'ok' : 'fail'}`}>
            {scene.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {scene.passed ? 'finished' : 'blocked'}
            {scene.reason && <span className="loop-theater__args">  {scene.reason}</span>}
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
