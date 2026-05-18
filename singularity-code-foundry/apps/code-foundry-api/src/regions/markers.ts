/**
 * M42.2 — Typed region marker emitter.
 *
 * Each language uses its native comment style. The shape is stable
 * across stacks so the Patch Guard parses one regex per language.
 *
 *   Java / TS:   // <generated:protected region="<id>">
 *                //   ...code...
 *                // </generated:protected>
 *   Python:      # <generated:protected region="<id>">
 *                #   ...code...
 *                # </generated:protected>
 *   YAML:        # <generated:protected region="<id>">
 *                #   ...config...
 *                # </generated:protected>
 *
 * llm-editable regions use the same comment style with the literal
 * tag `<llm-editable region="...">`. The Patch Guard maps tag → region
 * type via the ontology in src/regions/ontology.ts.
 */
import { regionSpec, type RegionMarkerLanguage } from './ontology.js'

type Marker = 'protected' | 'editable'

function commentPrefix(lang: RegionMarkerLanguage): string {
  if (lang === 'python' || lang === 'yaml') return '#'
  return '//'
}

function openTag(marker: Marker, regionId: string): string {
  return marker === 'protected'
    ? `<generated:protected region="${regionId}">`
    : `<llm-editable region="${regionId}">`
}

function closeTag(marker: Marker): string {
  return marker === 'protected' ? `</generated:protected>` : `</llm-editable>`
}

export interface FenceOptions {
  marker: Marker
  regionId: string
  language: RegionMarkerLanguage
  body: string
}

/**
 * Wrap a body in region markers. Validates the regionId against the
 * ontology so unknown regions never reach disk.
 */
export function fence(opts: FenceOptions): string {
  const spec = regionSpec(opts.regionId)
  if (opts.marker === 'editable' && !spec.editable) {
    throw new Error(`Region '${opts.regionId}' is protected; cannot emit it as llm-editable.`)
  }
  if (opts.marker === 'protected' && spec.editable) {
    throw new Error(`Region '${opts.regionId}' is llm-editable; cannot emit it as protected.`)
  }
  const c = commentPrefix(opts.language)
  return `${c} ${openTag(opts.marker, opts.regionId)}\n${opts.body}\n${c} ${closeTag(opts.marker)}`
}

/**
 * Inline (single-line) variant. The Patch Guard parses both shapes.
 * Useful for stamping the generator-source header at file top.
 */
export function headerComment(language: RegionMarkerLanguage, lines: string[]): string {
  const c = commentPrefix(language)
  return lines.map((line) => `${c} ${line}`).join('\n')
}
