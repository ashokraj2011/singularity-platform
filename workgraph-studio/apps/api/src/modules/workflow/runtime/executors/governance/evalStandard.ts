import { GatewayProvider } from '../../../../agent/llm/GatewayProvider'
import type { LLMRequest } from '../../../../agent/llm/LLMProvider'

/**
 * LLM-assisted STANDARD_CONFORMANCE — judges a DOCUMENT against a named STANDARD
 * via the Context Fabric gateway. `parseStandardVerdict` is pure + unit-tested;
 * `evaluateStandardConformance` is the gateway I/O (runtime-verified on a stack).
 * Deterministic standards checks remain available via artifact/receipt/predicate
 * bindings — this adds the qualitative LLM judge.
 */

export interface StandardCheck {
  standardName: string
  standardText?: string
  documentText?: string
  model?: string
}

export interface StandardVerdict {
  conformant: boolean
  findings: string[]
}

const SYSTEM_PROMPT =
  'You are a standards-conformance judge. Given a STANDARD and a DOCUMENT, decide whether the document conforms ' +
  'to the standard. Respond with ONLY a JSON object: {"conformant": boolean, "findings": string[]}. ' +
  'findings lists concrete violations (empty when conformant). Emit no prose outside the JSON.'

/** Pure: parse the judge's reply into a verdict (tolerant of surrounding prose). */
export function parseStandardVerdict(raw: string): StandardVerdict {
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw) as { conformant?: unknown; findings?: unknown }
    return {
      conformant: parsed.conformant === true,
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
    }
  } catch {
    return { conformant: false, findings: ['could not parse standards-judge response'] }
  }
}

export async function evaluateStandardConformance(check: StandardCheck): Promise<StandardVerdict> {
  const provider = new GatewayProvider()
  const req: LLMRequest = {
    model: check.model ?? 'default',
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `STANDARD: ${check.standardName}\n${check.standardText ?? '(standard text supplied out of band)'}\n\nDOCUMENT:\n${check.documentText ?? ''}`,
      },
    ],
    maxTokens: 1024,
  }
  const res = await provider.complete(req)
  return parseStandardVerdict(res.content ?? '')
}
