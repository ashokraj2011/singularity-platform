/**
 * M42.4 — Patent Chain D primitive: gap → typed LLM patch task.
 *
 * Each MISSING_BUSINESS_LOGIC / COMPILE_ERROR / TEST_FAILURE gap with
 * `llmEligible=true` produces a CodegenLlmPatchTask row whose shape is
 * the same payload the Patch Guard validates: target file, target
 * region id, enumerated allowed/forbidden change classes from the
 * ontology, taskType from a closed enum.
 *
 * Prompt content lives in prompt-composer (CI guard
 * bin/check-no-inline-prompts.sh forbids inline prompts). Composer's
 * compose-and-respond runs LLM Gateway → provider → diff back to us.
 */
import type { CodegenGap, LlmTaskType, Prisma } from '@prisma/client'
import { regionSpec } from '../regions/ontology.js'

export interface BuiltTask {
  taskType: LlmTaskType
  targetFile: string
  regionId: string
  targetClass?: string | null
  targetMethod?: string | null
  allowedChanges: string[]
  forbiddenChanges: string[]
  metadata: Prisma.InputJsonValue
}

const GAP_TYPE_TO_TASK_TYPE: Record<string, LlmTaskType> = {
  MISSING_BUSINESS_LOGIC: 'COMPLETE_METHOD_BODY',
  COMPILE_ERROR:          'FIX_COMPILE_ERROR',
  TEST_FAILURE:           'FIX_COMPILE_ERROR',  // M42.4.1 will split this out
  MISSING_TEST_CASE:      'GENERATE_ADDITIONAL_TESTS',
}

/**
 * Build a typed task from a gap. Returns null when the gap is not
 * LLM-eligible or cannot be anchored to a region.
 */
export function buildTaskFromGap(gap: CodegenGap): BuiltTask | null {
  if (!gap.llmEligible) return null
  if (!gap.filePath || !gap.regionId) return null

  const taskType = GAP_TYPE_TO_TASK_TYPE[gap.gapType]
  if (!taskType) return null

  const spec = regionSpec(gap.regionId)
  if (!spec.editable) return null

  return {
    taskType,
    targetFile: gap.filePath,
    regionId: gap.regionId,
    targetClass: gap.className,
    targetMethod: gap.methodName,
    allowedChanges: spec.allowedChanges as unknown as string[],
    forbiddenChanges: spec.forbiddenChanges as unknown as string[],
    metadata: {
      gapDescription: gap.description,
      recommendedResolution: gap.recommendedResolution,
    } as unknown as Prisma.InputJsonValue,
  }
}
