/**
 * M60 Slice 2 — send-back annotations.
 *
 * Two concerns are pinned here:
 *
 *  (1) Schema validation. The Zod schema on the API rejects anything
 *      that wouldn't be safe to render back into a future attempt's
 *      task: missing file/line, oversized comments, unknown severity,
 *      runaway counts.
 *
 *  (2) Template-var rendering. `buildPriorAttemptAnnotations` walks the
 *      reviewEvents newest-first and emits the structured block we feed
 *      to the next attempt's task. The shape is contractually stable —
 *      the loop-developer prompt template binds against the exact
 *      headings below.
 *
 * The function is pure (state in → string out); no DB needed.
 */
import { describe, it, expect } from 'vitest'
import {
  sendBackAnnotationSchema,
  buildPriorAttemptAnnotations,
} from '../src/modules/blueprint/blueprint.router'

// ---- (1) schema --------------------------------------------------------

describe('M60 Slice 2 — sendBackAnnotationSchema', () => {
  it('accepts a minimal well-formed annotation (no endLine, no severity)', () => {
    const parsed = sendBackAnnotationSchema.parse({
      file: 'src/main/java/Foo.java',
      startLine: 42,
      comment: 'Rewrite using a character-set ignore-case match.',
    })
    expect(parsed.file).toBe('src/main/java/Foo.java')
    expect(parsed.startLine).toBe(42)
    expect(parsed.endLine).toBeUndefined()
    expect(parsed.severity).toBeUndefined()
  })

  it('accepts the full shape with endLine + severity', () => {
    const parsed = sendBackAnnotationSchema.parse({
      file: 'src/x.ts',
      startLine: 10,
      endLine: 14,
      comment: 'Tighten the regex.',
      severity: 'must-fix',
    })
    expect(parsed.endLine).toBe(14)
    expect(parsed.severity).toBe('must-fix')
  })

  it('rejects missing file', () => {
    expect(() =>
      sendBackAnnotationSchema.parse({ startLine: 1, comment: 'x' }),
    ).toThrow()
  })

  it('rejects startLine = 0 (must be positive)', () => {
    expect(() =>
      sendBackAnnotationSchema.parse({ file: 'a', startLine: 0, comment: 'x' }),
    ).toThrow()
  })

  it('rejects empty comment', () => {
    expect(() =>
      sendBackAnnotationSchema.parse({ file: 'a', startLine: 1, comment: '' }),
    ).toThrow()
  })

  it('caps comment at 800 chars', () => {
    expect(() =>
      sendBackAnnotationSchema.parse({
        file: 'a',
        startLine: 1,
        comment: 'x'.repeat(801),
      }),
    ).toThrow()
  })

  it('rejects unknown severity strings', () => {
    expect(() =>
      sendBackAnnotationSchema.parse({
        file: 'a',
        startLine: 1,
        comment: 'x',
        severity: 'critical' as never,
      }),
    ).toThrow()
  })
})

// ---- (2) buildPriorAttemptAnnotations ---------------------------------

// LoopState is a heavy type; we only need reviewEvents for this helper.
// The function reads `state.reviewEvents` and nothing else.
type Anything = Parameters<typeof buildPriorAttemptAnnotations>[0]

function makeState(events: Array<{ type: string; targetStageKey?: string; annotations?: unknown[]; payload?: Record<string, unknown> }>): Anything {
  return {
    reviewEvents: events.map((ev, idx) => ({
      id: `ev-${idx}`,
      type: ev.type,
      message: 'test',
      createdAt: new Date(2026, 0, 1, 12, idx).toISOString(),
      // The helper reads payload.targetStageKey + payload.annotations.
      payload: ev.payload ?? {
        targetStageKey: ev.targetStageKey,
        annotations: ev.annotations,
      },
    })),
  } as Anything
}

describe('M60 Slice 2 — buildPriorAttemptAnnotations', () => {
  it('returns empty string when there are no review events at all', () => {
    expect(buildPriorAttemptAnnotations(makeState([]), 'design')).toBe('')
  })

  it('returns empty string when no SEND_BACK targets this stage', () => {
    const state = makeState([
      { type: 'SEND_BACK', targetStageKey: 'plan', annotations: [{ file: 'x', startLine: 1, comment: 'c' }] },
    ])
    expect(buildPriorAttemptAnnotations(state, 'design')).toBe('')
  })

  it('returns empty string when the latest send-back has no annotations array', () => {
    const state = makeState([
      { type: 'SEND_BACK', targetStageKey: 'design' }, // payload.annotations undefined
    ])
    expect(buildPriorAttemptAnnotations(state, 'design')).toBe('')
  })

  it('renders a single annotation with severity + range', () => {
    const state = makeState([
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [
          {
            file: 'src/main/java/Foo.java',
            startLine: 142,
            endLine: 148,
            severity: 'must-fix',
            comment: 'Rewrite using ignore-case match.',
          },
        ],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('## Reviewer line annotations (must address before re-running)')
    expect(out).toContain('- src/main/java/Foo.java:142-148  (must-fix)')
    expect(out).toContain('"Rewrite using ignore-case match."')
  })

  it('renders a single annotation without endLine or severity', () => {
    const state = makeState([
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [{ file: 'a.ts', startLine: 5, comment: 'c' }],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('- a.ts:5')
    expect(out).not.toMatch(/a\.ts:5\s+\(/) // no severity parens
  })

  it('picks the most recent SEND_BACK when multiple target the same stage', () => {
    const state = makeState([
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [{ file: 'old.ts', startLine: 1, comment: 'old' }],
      },
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [{ file: 'new.ts', startLine: 2, comment: 'new' }],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('new.ts')
    expect(out).not.toContain('old.ts')
  })

  it('honours AUTO_SEND_BACK events too', () => {
    const state = makeState([
      {
        type: 'AUTO_SEND_BACK',
        targetStageKey: 'design',
        annotations: [{ file: 'auto.ts', startLine: 7, comment: 'gate triggered' }],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('auto.ts:7')
  })

  it('drops malformed entries silently and keeps the well-formed ones', () => {
    const state = makeState([
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [
          { file: 'good.ts', startLine: 1, comment: 'kept' },
          { file: '', startLine: 1, comment: 'missing file' },
          { file: 'b.ts', startLine: 0, comment: 'bad line' },
          { file: 'c.ts', startLine: 1 }, // missing comment
        ],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('good.ts:1')
    expect(out).not.toContain('"missing file"')
    expect(out).not.toContain('b.ts:0')
    expect(out).not.toContain('c.ts')
  })

  it('escapes embedded quotes in the comment', () => {
    const state = makeState([
      {
        type: 'SEND_BACK',
        targetStageKey: 'design',
        annotations: [{ file: 'a', startLine: 1, comment: 'use "snake_case"' }],
      },
    ])
    const out = buildPriorAttemptAnnotations(state, 'design')
    expect(out).toContain('"use \\"snake_case\\""')
  })
})
