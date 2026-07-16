/**
 * Deterministic first-pass synthesis for Studio boards.
 *
 * The result is deliberately provider-independent: a fresh installation can
 * cluster an idea board without an LLM, and a later model can enrich the same
 * source-linked contract. Every insight carries its source object ids so a
 * human can inspect the notes behind it before promoting it into the spec.
 */

export type SynthesisKind = 'THEME' | 'TENSION' | 'OPPORTUNITY'

export interface SynthesisInsight {
  kind: SynthesisKind
  title: string
  summary: string
  sourceIds: string[]
  keywords: string[]
  confidence: number
}

export interface BoardSynthesis {
  sourceCount: number
  coveredSourceCount: number
  coverage: number
  themes: SynthesisInsight[]
  tensions: SynthesisInsight[]
  opportunities: SynthesisInsight[]
  warnings: string[]
}

export interface SynthesisBoardObject {
  id: string
  type?: unknown
  category?: unknown
  text?: unknown
  title?: unknown
  summary?: unknown
  body?: unknown
  deleted?: unknown
}

export interface BoardSynthesisOptions {
  objectIds?: string[]
  maxThemes?: number
  includeTensions?: boolean
  includeOpportunities?: boolean
}

const STRUCTURAL_TYPES = new Set(['connector', 'frame', 'synthesis', 'theme'])
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'by', 'can', 'could',
  'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its', 'may',
  'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the', 'their', 'then',
  'there', 'this', 'to', 'we', 'will', 'with', 'would', 'you', 'your',
])

const CATEGORY_RULES = [
  { key: 'USER', label: 'User needs', words: ['user', 'customer', 'buyer', 'team', 'person', 'people', 'experience', 'journey', 'adoption', 'pain'] },
  { key: 'MARKET', label: 'Market signal', words: ['market', 'competitor', 'revenue', 'price', 'pricing', 'sales', 'segment', 'demand', 'growth', 'value'] },
  { key: 'OPERATIONAL', label: 'Operating model', words: ['process', 'operation', 'support', 'workflow', 'manual', 'approval', 'cost', 'time', 'owner', 'handoff'] },
  { key: 'TECHNICAL', label: 'Technical direction', words: ['api', 'code', 'data', 'security', 'system', 'service', 'runtime', 'latency', 'integration', 'model'] },
] as const

const TENSION_RE = /\b(but|however|risk|concern|blocked|cannot|can't|uncertain|trade[- ]?off|versus|conflict|constraint|failure)\b/i
const OPPORTUNITY_RE = /\b(need|needs|want|could|opportunity|improve|reduce|automate|enable|faster|simplify|avoid|increase)\b/i

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectText(object: SynthesisBoardObject): string {
  return [stringValue(object.title), stringValue(object.text), stringValue(object.summary), stringValue(object.body)]
    .filter(Boolean)
    .join(' — ')
    .trim()
}

function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .filter(token => !STOP_WORDS.has(token) && !/^\d+$/.test(token))
}

function topKeywords(entries: Array<{ tokens: string[] }>, limit = 4): string[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const token of new Set(entry.tokens)) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

function categoryOf(tokens: string[]): { key: string; label: string } {
  const tokenSet = new Set(tokens)
  const scored = CATEGORY_RULES
    .map(rule => ({ rule, score: rule.words.filter(word => tokenSet.has(word)).length }))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.score ? scored[0].rule : { key: 'GENERAL', label: 'Emerging theme' }
}

function titleCase(value: string): string {
  return value.replace(/(^|\s)\S/g, char => char.toUpperCase())
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function synthesizeBoardObjects(
  objects: SynthesisBoardObject[],
  options: BoardSynthesisOptions = {},
): BoardSynthesis {
  const selectedIds = options.objectIds?.length ? new Set(options.objectIds) : null
  const source = objects
    .filter(object => !object.deleted)
    .filter(object => !selectedIds || selectedIds.has(object.id))
    .filter(object => !STRUCTURAL_TYPES.has(stringValue(object.type).toLowerCase()))
    .map(object => ({ object, text: objectText(object) }))
    .filter(entry => entry.text.length > 0)
    .map(entry => ({ ...entry, tokens: tokensOf(entry.text) }))

  if (!source.length) {
    return {
      sourceCount: 0,
      coveredSourceCount: 0,
      coverage: 0,
      themes: [],
      tensions: [],
      opportunities: [],
      warnings: ['Add at least one text note before running synthesis.'],
    }
  }

  const grouped = new Map<string, { label: string; entries: typeof source }>()
  for (const entry of source) {
    const explicitCategory = stringValue(entry.object.category).toUpperCase()
    const explicitRule = CATEGORY_RULES.find(rule => rule.key === explicitCategory)
    const category = explicitRule ?? categoryOf(entry.tokens)
    const current = grouped.get(category.key) ?? { label: category.label, entries: [] }
    current.entries.push(entry)
    grouped.set(category.key, current)
  }

  const maxThemes = Math.max(1, Math.min(12, options.maxThemes ?? 6))
  const themes = [...grouped.values()]
    .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label))
    .slice(0, maxThemes)
    .map(group => {
      const keywords = topKeywords(group.entries)
      const keywordLabel = keywords.slice(0, 2).map(titleCase).join(' + ')
      return {
        kind: 'THEME' as const,
        title: group.label === 'Emerging theme' && keywordLabel ? keywordLabel : group.label,
        summary: `${group.entries.length} idea${group.entries.length === 1 ? '' : 's'} converge around ${keywords.slice(0, 3).join(', ') || 'a shared direction'}.`,
        sourceIds: group.entries.map(entry => entry.object.id),
        keywords,
        confidence: Math.min(0.92, 0.52 + group.entries.length * 0.08),
      }
    })

  const tensions = options.includeTensions === false
    ? []
    : source
      .filter(entry => TENSION_RE.test(entry.text))
      .slice(0, 5)
      .map(entry => ({
        kind: 'TENSION' as const,
        title: 'Tension to resolve',
        summary: entry.text,
        sourceIds: [entry.object.id],
        keywords: topKeywords([entry]),
        confidence: 0.68,
      }))

  const opportunities = options.includeOpportunities === false
    ? []
    : source
      .filter(entry => OPPORTUNITY_RE.test(entry.text))
      .slice(0, 5)
      .map(entry => ({
        kind: 'OPPORTUNITY' as const,
        title: 'Opportunity',
        summary: entry.text,
        sourceIds: [entry.object.id],
        keywords: topKeywords([entry]),
        confidence: 0.64,
      }))

  const covered = unique(themes.flatMap(theme => theme.sourceIds))
  return {
    sourceCount: source.length,
    coveredSourceCount: covered.length,
    coverage: source.length ? covered.length / source.length : 0,
    themes,
    tensions,
    opportunities,
    warnings: source.length < 3 ? ['Synthesis is more useful with at least three independent notes.'] : [],
  }
}
