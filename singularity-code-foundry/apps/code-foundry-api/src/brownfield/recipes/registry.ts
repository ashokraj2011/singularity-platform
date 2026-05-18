/**
 * M42.5 — Recipe registry.
 *
 * A recipe is a typed (enhancement.type × language × framework) →
 * deterministic per-file editor. Recipes are pure functions that take
 * the file's current text + the change op and return a `RecipeOutput`:
 *
 *   - `editedFiles`     filePath → new content (text edits, no diff
 *                       parsing needed; the caller writes them through
 *                       the patchGuard apply layer for consistency)
 *   - `llmTasks`        an optional list of LlmPatchTask seeds for the
 *                       operations the recipe could not fully resolve.
 *                       Each task references a single editable region
 *                       the recipe just emitted into the file.
 *
 * V1 only ships one recipe: ADD_RESPONSE_FIELD, with three per-stack
 * implementations. The registry is shaped so the dispatcher just looks
 * up by (enhancement.type, framework).
 */
import type { Framework } from '../types.js'
import type { ChangeOperation, EnhancementSpec, RepoModel } from '../types.js'
import { addResponseFieldSpring } from './addResponseField/springboot.js'
import { addResponseFieldFastApi } from './addResponseField/fastapi.js'
import { addResponseFieldExpress } from './addResponseField/express.js'

export interface RecipeContext {
  repoPath: string
  enhancementSpec: EnhancementSpec
  repoModel: RepoModel
  operation: ChangeOperation
}

export interface LlmTaskSeed {
  // The fields a CodegenLlmPatchTask row needs that don't come from
  // the run row itself.
  taskType: 'COMPLETE_MAPPING_LOGIC' | 'UPDATE_TEST_ASSERTIONS'
  targetFile: string
  targetClass?: string
  targetMethod?: string
  regionId: string
  allowedChanges: string[]
  forbiddenChanges: string[]
  metadata?: Record<string, unknown>
}

export interface RecipeOutput {
  editedFiles: Array<{ filePath: string; content: string }>
  llmTasks: LlmTaskSeed[]
  notes: string[]
}

export type RecipeFn = (ctx: RecipeContext) => RecipeOutput

/**
 * Look up a recipe implementation for an (enhancement.type, framework)
 * pair. Returns `undefined` when no recipe is known — the dispatcher
 * uses that as the signal to fall back to the LLM-proposes-plan branch.
 */
export function lookupRecipe(
  enhancementType: string,
  framework: Framework,
): RecipeFn | undefined {
  if (enhancementType === 'ADD_RESPONSE_FIELD') {
    switch (framework) {
      case 'spring-boot': return addResponseFieldSpring
      case 'fastapi':     return addResponseFieldFastApi
      case 'express':     return addResponseFieldExpress
    }
  }
  return undefined
}
