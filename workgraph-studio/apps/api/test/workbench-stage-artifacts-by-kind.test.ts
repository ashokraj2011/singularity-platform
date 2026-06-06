/**
 * Proves the contract behind the user-facing question:
 * "do the artifacts I define on the workbench node's stages flow to the node's
 *  outputs in the workgraph?"
 *
 * At completion, buildFinalPack collects the accepted per-stage artifacts into
 * finalPack.stageConsumables, and attachFinalPackToWorkflowNode writes
 *   stageArtifactsByKind: stageConsumablesByKind(finalPack.stageConsumables)
 * onto the WORKBENCH_TASK node. The node declares `stageArtifactsByKind`
 * (bindingPath `workbench.stageArtifactsByKind`) as a first-class output, so a
 * downstream node binds `workbench.stageArtifactsByKind.<kind>`.
 *
 * This test pins the kind→map grouping that makes that binding work.
 */
import { describe, it, expect } from 'vitest'
import { stageConsumablesByKind } from '../src/modules/blueprint/blueprint.router'

const ref = (artifactKind: string, stageKey: string, over: Record<string, unknown> = {}) => ({
  artifactId: `a-${artifactKind}-${stageKey}`,
  artifactKind,
  title: `${artifactKind} (${stageKey})`,
  consumableId: `c-${artifactKind}-${stageKey}`,
  consumableVersion: 1,
  status: 'PUBLISHED',
  stageKey,
  ...over,
})

describe('workbench stage artifacts → node output (stageArtifactsByKind)', () => {
  it('keys each declared artifact kind so a downstream node can bind it', () => {
    const stageConsumables = [
      ref('story_brief', 'INTAKE'),
      ref('solution_architecture', 'DESIGN'),
      ref('code_change', 'DEVELOP'),
      ref('test_report', 'QA'),
    ]
    const byKind = stageConsumablesByKind(stageConsumables as never)

    // Exactly the keys a downstream `workbench.stageArtifactsByKind.<kind>` binding needs.
    expect(Object.keys(byKind).sort()).toEqual([
      'code_change', 'solution_architecture', 'story_brief', 'test_report',
    ])
    // The mapped value carries the published consumable for that kind.
    expect(byKind.code_change).toHaveLength(1)
    expect(byKind.code_change[0].consumableId).toBe('c-code_change-DEVELOP')
    expect(byKind.code_change[0].title).toContain('code_change')
  })

  it('collects multiple artifacts of the same kind under one key', () => {
    const byKind = stageConsumablesByKind([
      ref('code_change', 'DEVELOP'),
      ref('code_change', 'FIX'),
    ] as never)
    expect(byKind.code_change).toHaveLength(2)
    expect(byKind.code_change.map(r => r.stageKey)).toEqual(['DEVELOP', 'FIX'])
  })

  it('falls back to "artifact" when a kind is empty', () => {
    const byKind = stageConsumablesByKind([ref('', 'X', { artifactKind: '' })] as never)
    expect(byKind.artifact).toHaveLength(1)
  })
})
