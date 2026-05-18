/**
 * M42.0 — Foundry feature-flag keys.
 *
 * Adding a new flag is three places:
 *   1. The FoundryFlag union below.
 *   2. The default seeded in workgraph-studio/apps/api/prisma/seed.ts.
 *   3. (If hierarchical) the parent check in resolveEnabled().
 */
export type FoundryFlag =
  | 'code_foundry.enabled'
  | 'code_foundry.greenfield.enabled'
  | 'code_foundry.brownfield.enabled'
  | 'code_foundry.llm_patch.enabled'

export interface FeatureFlagRecord {
  key: string
  enabled: boolean
  description: string | null
  updatedById: string | null
  updatedAt: string
}

/**
 * Parent → child ancestry. A child is only effective when ITSELF and
 * every ancestor (transitively) are enabled. Single level for V1 — the
 * master `code_foundry.enabled` gates everything Foundry-related.
 */
export const FLAG_PARENTS: Partial<Record<FoundryFlag, FoundryFlag[]>> = {
  'code_foundry.greenfield.enabled': ['code_foundry.enabled'],
  'code_foundry.brownfield.enabled': ['code_foundry.enabled'],
  'code_foundry.llm_patch.enabled':  ['code_foundry.enabled'],
}
