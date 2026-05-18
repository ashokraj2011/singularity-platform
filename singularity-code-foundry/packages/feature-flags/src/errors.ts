import type { FoundryFlag } from './types'

/**
 * Thrown by assertEnabled when the requested flag (or any ancestor) is
 * off. Carries a structured payload so the REST middleware can map it
 * cleanly to a 503 + JSON body, and the CLI can render it as a single
 * line with a non-zero exit code.
 */
export class FeatureDisabledError extends Error {
  public readonly code = 'FEATURE_DISABLED'
  public readonly flag: FoundryFlag
  public readonly disabledAncestor?: FoundryFlag

  constructor(flag: FoundryFlag, disabledAncestor?: FoundryFlag) {
    const because = disabledAncestor && disabledAncestor !== flag
      ? `because ancestor '${disabledAncestor}' is OFF`
      : 'is OFF'
    super(`Foundry feature '${flag}' ${because}. Toggle it on the Operations page or via PUT /api/admin/feature-flags/${disabledAncestor ?? flag}.`)
    this.name = 'FeatureDisabledError'
    this.flag = flag
    this.disabledAncestor = disabledAncestor
  }

  toJSON() {
    return {
      code: this.code,
      flag: this.flag,
      disabledAncestor: this.disabledAncestor ?? this.flag,
      message: this.message,
    }
  }
}
