/**
 * Pseudo-code generation — the pure pieces (Spec Studio). Builds the prompt from the spec's
 * requirements and parses the model's fenced code back out. No I/O and no model call here (those
 * live in the service behind the same injectable LLM as spec generation), so prompt-shaping +
 * parsing are unit-testable.
 */

export interface PseudocodeRequirement {
  id: string
  statement: string
  priority: string
}

export function pseudocodeSystemPrompt(): string {
  return [
    'You are a senior engineer writing clear, idiomatic REFERENCE pseudo-code for a set of',
    'requirements. Produce readable code a developer can translate directly, with short comments',
    'tying blocks back to the requirement ids they realize.',
    '',
    'Return ONLY a single fenced code block in the requested language — no prose before or after:',
    '```<language>',
    '// REQ-1: <what this satisfies>',
    '<code>',
    '```',
  ].join('\n')
}

export function buildPseudocodeTask(input: {
  title?: string
  language: string
  requirements: PseudocodeRequirement[]
  instructions?: string
}): string {
  const reqs = input.requirements.map((r) => `- ${r.id} [${r.priority}]: ${r.statement}`).join('\n')
  return [
    `Language: ${input.language}`,
    input.title ? `Module: ${input.title}` : '',
    input.instructions ? `Extra guidance: ${input.instructions}` : '',
    'Requirements to implement:',
    reqs || '(no specific requirements — infer a reasonable module from the module name)',
    '',
    `Write the ${input.language} reference implementation now.`,
  ].filter(Boolean).join('\n')
}

/** Pull the fenced code (and its language) out of a model response; fall back to the raw text. */
export function parsePseudocode(text: string, fallbackLanguage: string): { content: string; language: string } {
  const fence = text.match(/```([\w+-]+)?\s*([\s\S]*?)```/)
  if (fence && fence[2].trim()) {
    return { language: (fence[1] || fallbackLanguage).toLowerCase(), content: fence[2].trim() }
  }
  return { language: fallbackLanguage, content: text.trim() }
}
