/**
 * Synthesis Studio — agent response parsing (R1A Agents phase). PURE. The governed turn is
 * asked to answer with a single JSON object { message, proposalItems, citations }; agents
 * PROPOSE via items and never claim to have applied anything. Parsing is tolerant: non-JSON
 * output is treated as a plain answer (message only, no items) so a chatty model never
 * accidentally produces a mutation.
 */
import { z } from 'zod'

export interface ProposedItem {
  kind: string
  title?: string
  targetEntityType?: string
  targetEntityId?: string
  diff?: Record<string, unknown>
  citations?: unknown[]
  uncertainty?: number
}
export interface ParsedAgentTurn {
  message: string
  proposalItems: ProposedItem[]
  citations: unknown[]
}

const itemSchema = z.object({
  kind: z.string().min(1),
  title: z.string().optional(),
  targetEntityType: z.string().optional(),
  targetEntityId: z.string().optional(),
  diff: z.record(z.unknown()).optional(),
  citations: z.array(z.unknown()).optional(),
  uncertainty: z.number().min(0).max(1).optional(),
})
const turnSchema = z.object({
  message: z.string().default(''),
  proposalItems: z.array(itemSchema).max(50).default([]),
  citations: z.array(z.unknown()).default([]),
})

/** Extract the first balanced-ish JSON object from fenced or bare text. */
export function extractJsonObject(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

export function parseAgentTurn(raw: string): ParsedAgentTurn {
  const obj = extractJsonObject(raw)
  if (obj && typeof obj === 'object') {
    const parsed = turnSchema.safeParse(obj)
    if (parsed.success) {
      return { message: parsed.data.message || raw.trim(), proposalItems: parsed.data.proposalItems, citations: parsed.data.citations }
    }
  }
  return { message: raw.trim(), proposalItems: [], citations: [] }
}

/** The response-shape instruction appended to the agent's system prompt. */
export function responseContract(allowedTools: string[]): string {
  return [
    'Respond with a SINGLE JSON object: { "message": string, "proposalItems": [], "citations": [] }.',
    `Each proposalItem is { "kind": one of ${JSON.stringify(allowedTools)}, "title"?, "targetEntityType"?, "targetEntityId"?, "diff"?: object, "citations"?: [], "uncertainty"?: 0..1 }.`,
    'Propose changes ONLY as items — never state that you applied, approved, published, or completed anything. If you are only answering, return an empty proposalItems array.',
  ].join(' ')
}
