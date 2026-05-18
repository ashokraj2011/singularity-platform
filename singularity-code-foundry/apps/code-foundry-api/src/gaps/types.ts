/**
 * M42.3 — Gap types. Mirrors the GapType enum on the Prisma model
 * exactly so Foundry code can use this union and Prisma writes accept
 * it as-is via `enum` coercion.
 */
import type { GapType, GapSeverity } from '@prisma/client'

export interface DetectedGap {
  type: GapType
  severity: GapSeverity
  filePath?: string
  className?: string
  methodName?: string
  regionId?: string
  description: string
  recommendedResolution?: string
  llmEligible: boolean
}
