/**
 * stageMode — the single source of truth for "what kind of workspace does this
 * stage need". The Workbench renders entirely from the workflow's stage policy
 * (contextPolicy / toolPolicy / repoAccess), NOT from hardcoded stage names.
 *
 * Resolution is policy-first; when a workflow omits policy fields it falls back
 * to a role/name signature that mirrors the backend's normalizeStageContextPolicy
 * / normalizeStageToolPolicy (blueprint.router.ts), so a stage never renders
 * blank — and it upgrades automatically once policy fields are present.
 *
 * Pure, dependency-free (no React / network) — unit-testable in isolation.
 */
import type { StageContextPolicy, StageToolPolicy } from '../api'

export type StageMode = 'STORY' | 'PLAN' | 'CODE' | 'VERIFY' | 'EVIDENCE'

type StageLike = {
  key?: string
  label?: string
  agentRole?: string
  terminal?: boolean
  contextPolicy?: StageContextPolicy
  toolPolicy?: StageToolPolicy
  repoAccess?: boolean
  expectedArtifacts?: Array<{ format?: string } | unknown>
}

function signature(stage: StageLike): string {
  return `${stage.key ?? ''} ${stage.label ?? ''} ${stage.agentRole ?? ''}`.toLowerCase()
}

/** Classify a stage into a workspace mode. Never returns undefined. */
export function stageMode(stage: StageLike | undefined | null): StageMode {
  if (!stage) return 'PLAN'

  // ── Policy-first (authoritative when the workflow declares it) ────────────
  const ctx = stage.contextPolicy
  const tool = stage.toolPolicy
  if (ctx === 'CODE_EDIT' || tool === 'MUTATION') return 'CODE'
  if (ctx === 'VERIFY_ONLY' || tool === 'VERIFICATION') return 'VERIFY'
  if (ctx === 'EVIDENCE_REVIEW') return 'EVIDENCE'
  if (ctx === 'STORY_ONLY' || (tool === 'NONE' && stage.repoAccess === false)) return 'STORY'
  if (ctx === 'REPO_READ_ONLY') return 'PLAN'

  // ── Signature fallback (mirrors backend normalizeStage* heuristics) ───────
  // Order matters: non-mutating intents are checked before the generic
  // "code" → CODE match, and "code" is word-bounded so it doesn't trip on
  // encode/decode/codebase. Terminal stages default to the evidence pack.
  const sig = signature(stage)
  if (sig.includes('intake') || sig.includes('story') || sig.includes('product_owner') || sig.includes('clarif') || sig.includes('requirement') || sig.includes('brief')) return 'STORY'
  if (sig.includes('verify') || sig.includes('qa') || sig.includes('quality') || sig.includes('test')) return 'VERIFY'
  if (stage.terminal || sig.includes('review') || sig.includes('evidence') || sig.includes('approval') || sig.includes('signoff') || sig.includes('sign-off') || sig.includes('certif')) return 'EVIDENCE'
  if (sig.includes('develop') || sig.includes('developer') || sig.includes('engineer') || sig.includes('implement') || sig.includes('build') || /\bcode\b/.test(sig)) return 'CODE'
  if (sig.includes('plan') || sig.includes('design') || sig.includes('architect') || sig.includes('spec')) return 'PLAN'

  // Last resort: if the stage expects code artifacts, treat as CODE; else PLAN.
  const expectsCode = Array.isArray(stage.expectedArtifacts) && stage.expectedArtifacts.some(
    (a) => a !== null && typeof a === 'object' && (a as { format?: string }).format === 'CODE',
  )
  return expectsCode ? 'CODE' : 'PLAN'
}

/** True when the stage may edit the repo (code mutation controls / diff / review). */
export function stageAllowsMutation(stage: StageLike | undefined | null): boolean {
  if (!stage) return false
  if (stage.contextPolicy === 'CODE_EDIT' || stage.toolPolicy === 'MUTATION') return true
  // Only fall back to mode-by-signature when policy is absent.
  if (stage.contextPolicy || stage.toolPolicy) return false
  return stageMode(stage) === 'CODE'
}

/** True when the stage operates against the materialized repo (read or write). */
export function stageUsesRepoContext(stage: StageLike | undefined | null): boolean {
  if (!stage) return false
  if (stage.contextPolicy || stage.toolPolicy || typeof stage.repoAccess === 'boolean') {
    return stage.repoAccess !== false && stage.contextPolicy !== 'STORY_ONLY' && stage.toolPolicy !== 'NONE'
  }
  const m = stageMode(stage)
  return m === 'PLAN' || m === 'CODE' || m === 'VERIFY'
}

/** True when the stage runs verifiers (test/command runners). */
export function stageRunsVerification(stage: StageLike | undefined | null): boolean {
  if (!stage) return false
  if (stage.toolPolicy) return stage.toolPolicy === 'VERIFICATION'
  return stageMode(stage) === 'VERIFY'
}

export interface StageModeMeta {
  label: string
  /** lucide-react icon name already imported in App.tsx, by convention. */
  icon: 'BookOpen' | 'Brain' | 'Code2' | 'ClipboardCheck' | 'BadgeCheck'
  /** CSS modifier suffix for badges/shell, e.g. `mode-CODE`. */
  chipClass: string
}

const MODE_META: Record<StageMode, StageModeMeta> = {
  STORY:    { label: 'Story',    icon: 'BookOpen',       chipClass: 'mode-STORY' },
  PLAN:     { label: 'Plan',     icon: 'Brain',          chipClass: 'mode-PLAN' },
  CODE:     { label: 'Code',     icon: 'Code2',          chipClass: 'mode-CODE' },
  VERIFY:   { label: 'Verify',   icon: 'ClipboardCheck', chipClass: 'mode-VERIFY' },
  EVIDENCE: { label: 'Evidence', icon: 'BadgeCheck',     chipClass: 'mode-EVIDENCE' },
}

export function stageModeMeta(mode: StageMode): StageModeMeta {
  return MODE_META[mode]
}

// ── M100 — governed phases (for per-phase model overrides) ──────────────────
// Mirrors the Phase enum in context-fabric (governed/phase_state.py).
export const GOVERNED_PHASES = ['PLAN', 'EXPLORE', 'ACT', 'VERIFY', 'REPAIR', 'SELF_REVIEW', 'FINALIZE'] as const
export type GovernedPhase = (typeof GOVERNED_PHASES)[number]

// Which governed phases are worth exposing per stage mode. Unset phases simply
// inherit the stage-level model, and CF only consults phases it actually runs,
// so these lists are about UI relevance, not correctness. CODE exposes the full
// loop (it's the only mode that mutates + repairs + verifies).
const PHASES_BY_MODE: Record<StageMode, readonly GovernedPhase[]> = {
  STORY:    ['PLAN', 'EXPLORE'],
  PLAN:     ['PLAN', 'EXPLORE', 'SELF_REVIEW'],
  CODE:     GOVERNED_PHASES,
  VERIFY:   ['EXPLORE', 'VERIFY', 'REPAIR', 'SELF_REVIEW'],
  EVIDENCE: ['SELF_REVIEW', 'FINALIZE'],
}

/** Governed phases relevant to a stage, for the per-phase model picker. */
export function phasesForMode(mode: StageMode): readonly GovernedPhase[] {
  return PHASES_BY_MODE[mode] ?? GOVERNED_PHASES
}

const PHASE_LABELS: Record<GovernedPhase, string> = {
  PLAN:        'Plan',
  EXPLORE:     'Explore',
  ACT:         'Act',
  VERIFY:      'Verify',
  REPAIR:      'Repair',
  SELF_REVIEW: 'Self-review',
  FINALIZE:    'Finalize',
}

/** Human label for a governed phase (falls back to the raw key). */
export function phaseLabel(phase: string): string {
  return (PHASE_LABELS as Record<string, string>)[phase] ?? phase
}
