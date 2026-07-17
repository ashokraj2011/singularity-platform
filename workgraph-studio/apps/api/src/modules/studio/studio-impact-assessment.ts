import { z } from 'zod'

const riskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  mitigation: z.string().trim().min(1).max(1000),
})

const claimSchema = z.object({
  statement: z.string().trim().min(1).max(1200),
  claimType: z.enum(['MARKET', 'USER', 'OPERATIONAL', 'TECHNICAL']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(1000),
})

export const capabilityImpactResultSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  recommendations: z.array(z.string().trim().min(1).max(1000)).max(8),
  risks: z.array(riskSchema).max(8),
  dependencies: z.array(z.string().trim().min(1).max(1000)).max(8),
  suggestedClaims: z.array(claimSchema).max(8),
})

export type CapabilityImpactResult = z.infer<typeof capabilityImpactResultSchema>

export function parseCapabilityImpactResult(raw: string): CapabilityImpactResult {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Capability agent did not return a JSON object')
  return capabilityImpactResultSchema.parse(JSON.parse(text.slice(start, end + 1)))
}

export function capabilityImpactSystemPrompt(capabilityName: string, agentName: string): string {
  return [
    `You are ${agentName}, representing the ${capabilityName} capability.`,
    'Assess how the proposed initiative affects your capability, its systems, teams, controls, and delivery commitments.',
    'Be specific, concise, and constructive. Identify hidden dependencies and falsifiable claims, not generic advice.',
    'Return only valid JSON matching the requested contract. Do not include markdown.',
  ].join(' ')
}

export function capabilityImpactTask(input: {
  name: string
  mission?: string | null
  primaryCapabilityName?: string | null
  capabilityName: string
  businessValue?: number | null
  customerImpact?: number | null
  strategicAlignment?: number | null
  urgency?: number | null
  deliveryRisk?: number | null
  technicalRisk?: number | null
  regulatoryRisk?: number | null
  confidence?: number | null
  effort?: number | null
  targetDate?: Date | null
  successMetrics?: unknown
}): string {
  return JSON.stringify({
    task: 'Produce a capability impact brief for this initiative.',
    initiative: {
      name: input.name,
      mission: input.mission ?? null,
      primaryCapability: input.primaryCapabilityName ?? null,
      reviewingCapability: input.capabilityName,
      scores: {
        businessValue: input.businessValue ?? null,
        customerImpact: input.customerImpact ?? null,
        strategicAlignment: input.strategicAlignment ?? null,
        urgency: input.urgency ?? null,
        deliveryRisk: input.deliveryRisk ?? null,
        technicalRisk: input.technicalRisk ?? null,
        regulatoryRisk: input.regulatoryRisk ?? null,
        confidence: input.confidence ?? null,
        effort: input.effort ?? null,
      },
      targetDate: input.targetDate?.toISOString() ?? null,
      successMetrics: input.successMetrics ?? [],
    },
    outputContract: {
      summary: 'string',
      recommendations: ['string'],
      risks: [{ title: 'string', severity: 'LOW|MEDIUM|HIGH|CRITICAL', mitigation: 'string' }],
      dependencies: ['string'],
      suggestedClaims: [{ statement: 'string', claimType: 'MARKET|USER|OPERATIONAL|TECHNICAL', confidence: 'number 0..1', rationale: 'string' }],
    },
  })
}
