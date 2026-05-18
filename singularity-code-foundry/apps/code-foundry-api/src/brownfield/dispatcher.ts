/**
 * M42.5 — Brownfield Dispatcher (Patent Chain C).
 *
 * Given a ChangePlan whose `knownPattern: true`, walk the operations
 * and either:
 *   - apply the per-stack recipe (deterministic ops + LLM-eligible
 *     ones that the recipe stubs with an editable region), or
 *   - record the operation as needing LLM-proposed-plan handling
 *     (`knownPattern: false`) — that branch is the M42.5+1 follow-on
 *     and currently surfaces a clear error.
 *
 * Recipes return the new file contents; the dispatcher batches them
 * through `applyEdits()` which uses the same fs-write layer the Patch
 * Guard uses for LLM-proposed diffs. That keeps the on-disk write
 * point single-sourced.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { lookupRecipe, type LlmTaskSeed } from './recipes/registry.js'
import { runBrownfieldGuard } from './brownfieldGuard.js'
import type {
  ChangeOperation, ChangePlan, EnhancementSpec, RepoModel,
} from './types.js'

export interface DispatchInput {
  repoPath: string
  enhancementSpec: EnhancementSpec
  repoModel: RepoModel
  plan: ChangePlan
  /** When true, recipe outputs are written to disk. When false, the
   *  dispatcher returns the planned writes without committing —
   *  useful for dry-run + UI preview. */
  apply: boolean
}

export interface DispatchedFile {
  filePath: string
  beforeHash: string | null
  afterHash: string
  bytesWritten: number
}

export interface DispatchOutcome {
  status: 'OK' | 'BLOCKED' | 'UNKNOWN_PATTERN'
  reason?: string
  recipeNotes: string[]
  edits: DispatchedFile[]
  llmTasks: LlmTaskSeed[]
  /** Ops the dispatcher could not handle (recipe returned no edit AND
   *  no LLM task). Surfaced so the operator can intervene manually. */
  unresolvedOperations: ChangeOperation[]
}

export function dispatchChangePlan(input: DispatchInput): DispatchOutcome {
  const { repoPath, enhancementSpec, repoModel, plan, apply } = input

  if (!plan.knownPattern) {
    return {
      status: 'UNKNOWN_PATTERN',
      reason: 'Plan has no known pattern; LLM-proposed-plan branch is M42.5.1 follow-on.',
      recipeNotes: [],
      edits: [],
      llmTasks: [],
      unresolvedOperations: plan.operations,
    }
  }

  // Brownfield guard runs BEFORE we touch disk — it validates the
  // plan against the recipe-independent invariants (preserve public
  // endpoints, audit events, security config).
  const guard = runBrownfieldGuard({
    repoModel,
    plan,
    enhancementSpec,
  })
  if (!guard.passed) {
    return {
      status: 'BLOCKED',
      reason: guard.reason,
      recipeNotes: [],
      edits: [],
      llmTasks: [],
      unresolvedOperations: plan.operations,
    }
  }

  const allNotes: string[] = []
  const edits: DispatchedFile[] = []
  const llmTasks: LlmTaskSeed[] = []
  const unresolved: ChangeOperation[] = []

  // Build an in-memory map so the second op for the same file sees the
  // first op's edits, not the on-disk content. Recipes read from disk
  // for V1 (small surface), so we write between ops when `apply: true`.
  for (const op of plan.operations) {
    const recipe = lookupRecipe(plan.changeType, repoModel.application.framework)
    if (!recipe) {
      unresolved.push(op)
      allNotes.push(`No recipe for (${plan.changeType}, ${repoModel.application.framework}).`)
      continue
    }
    const out = recipe({
      repoPath,
      enhancementSpec,
      repoModel,
      operation: op,
    })
    allNotes.push(...out.notes)
    llmTasks.push(...out.llmTasks)
    if (out.editedFiles.length === 0 && out.llmTasks.length === 0) {
      unresolved.push(op)
      continue
    }
    if (apply) {
      for (const f of out.editedFiles) {
        const abs = join(repoPath, f.filePath)
        const beforeHash = existsSync(abs)
          ? sha256(readSafe(abs))
          : null
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, f.content, 'utf8')
        edits.push({
          filePath: f.filePath,
          beforeHash,
          afterHash: sha256(f.content),
          bytesWritten: Buffer.byteLength(f.content, 'utf8'),
        })
      }
    } else {
      for (const f of out.editedFiles) {
        edits.push({
          filePath: f.filePath,
          beforeHash: null,
          afterHash: sha256(f.content),
          bytesWritten: Buffer.byteLength(f.content, 'utf8'),
        })
      }
    }
  }

  return {
    status: 'OK',
    recipeNotes: allNotes,
    edits,
    llmTasks,
    unresolvedOperations: unresolved,
  }
}

function readSafe(abs: string): string {
  try {
    // dynamic require to avoid an extra top-level import — the dispatcher
    // is the only module that needs it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    return fs.readFileSync(abs, 'utf8')
  } catch { return '' }
}

function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`
}
