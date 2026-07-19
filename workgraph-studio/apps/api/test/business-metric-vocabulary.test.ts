/**
 * Contract: the BUSINESS_METRIC catalog, and how an objective references it.
 *
 * `targetMetric` was free text validated only by Zod, so "Activation rate" and
 * "activation %" were different metrics forever. `metricKey` is an OPTIONAL soft
 * reference into MetadataDefinition — soft because targetMetric is JSON and the
 * catalog is versioned + scoped, and because every existing free-text objective
 * has to keep working untouched.
 *
 * The load-bearing assertions here are the ones about NOT breaking things: no key
 * means today's behaviour exactly, and the catalog never overrides what a caller
 * explicitly said.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
const metadataRouter = readFileSync(join(root, 'src/modules/metadata/metadata.router.ts'), 'utf8')
const alignmentRouter = readFileSync(join(root, 'src/modules/business-alignment/business-alignment.router.ts'), 'utf8')
const migration = readFileSync(join(root, 'prisma/migrations/20260719230000_business_metric_kind/migration.sql'), 'utf8')

describe('BUSINESS_METRIC catalog kind', () => {
  it('exists in the Prisma enum', () => {
    const block = schema.slice(schema.indexOf('enum MetadataDefinitionKind'))
    expect(block.slice(0, block.indexOf('}'))).toMatch(/^\s*BUSINESS_METRIC$/m)
  })

  it('is added by an idempotent, additive migration', () => {
    expect(migration).toMatch(/ADD VALUE IF NOT EXISTS 'BUSINESS_METRIC'/)
  })

  it('is present in the router kinds array', () => {
    // THE trap. This array is the query filter as well as the create-validation
    // set, so a kind in the enum but missing here is not a validation error — it
    // is silently absent from every list response, and the catalog just looks
    // empty. Nothing else in the codebase couples these two.
    expect(metadataRouter).toMatch(/const kinds = \[[^\]]*'BUSINESS_METRIC'[^\]]*\] as const/)
  })

  it('keeps the router array in step with the enum', () => {
    const enumBlock = schema.slice(schema.indexOf('enum MetadataDefinitionKind'))
    const enumValues = (enumBlock.slice(0, enumBlock.indexOf('}')).match(/^\s{2}([A-Z][A-Z0-9_]*)$/gm) ?? [])
      .map(line => line.trim())
    const arrayValues = (metadataRouter.match(/const kinds = \[([^\]]*)\]/)?.[1] ?? '')
      .split(',').map(v => v.trim().replace(/'/g, '')).filter(Boolean)
    expect(arrayValues.sort()).toEqual(enumValues.sort())
  })
})

describe('objective metricKey', () => {
  it('is optional, so existing free-text objectives are unaffected', () => {
    expect(alignmentRouter).toMatch(/metricKey: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.optional\(\)/)
  })

  it('resolves only ACTIVE definitions', () => {
    // A DEPRECATED or ARCHIVED metric is precisely the one nobody should attach
    // new objectives to; accepting it would defeat having a lifecycle.
    expect(alignmentRouter).toMatch(/kind: 'BUSINESS_METRIC'[\s\S]{0,120}?status: 'ACTIVE'/)
  })

  it('takes the newest version of a key', () => {
    expect(alignmentRouter).toMatch(/orderBy: \{ version: 'desc' \}/)
  })

  it('rejects a key that names nothing usable, and says how to proceed', () => {
    expect(alignmentRouter).toMatch(/not an active entry in the business metric catalog/)
    expect(alignmentRouter).toMatch(/leave metricKey empty and type the metric name/)
  })

  it('fills unit and direction only when the caller omitted them', () => {
    // The catalog is a DEFAULT, not an override. Measuring the same metric in a
    // different unit is a real case, and silently rewriting the caller's unit
    // would be worse than letting it differ.
    expect(alignmentRouter).toMatch(/if \(targetMetric && targetMetric\.unit == null\)/)
    expect(alignmentRouter).toMatch(/if \(targetMetric && targetMetric\.direction == null\)/)
  })

  it('short-circuits when no key was supplied', () => {
    // The common path must not pay for a catalog lookup it cannot need.
    expect(alignmentRouter).toMatch(/if \(!key\) return/)
  })

  it('runs on BOTH create and update', () => {
    // Validating only on create would let an edit smuggle in a bad key.
    const create = alignmentRouter.slice(alignmentRouter.indexOf("businessAlignmentRouter.post('/business-alignment/objectives'"))
    expect(create.slice(0, 300)).toMatch(/resolveMetricKey\(req\.body\?\.targetMetric\)/)
    const patch = alignmentRouter.slice(alignmentRouter.indexOf("businessAlignmentRouter.patch('/business-alignment/objectives/:objectiveId'"))
    expect(patch.slice(0, 300)).toMatch(/resolveMetricKey\(req\.body\?\.targetMetric\)/)
  })
})
