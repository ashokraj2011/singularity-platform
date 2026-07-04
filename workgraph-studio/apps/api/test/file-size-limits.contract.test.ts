import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph file size limit configuration contracts', () => {
  it('bounds document upload byte limits before wiring multer', () => {
    const router = source('src/modules/document/documents.router.ts')

    expect(router).toContain("import { boundedByteLimit } from '../../lib/env-limits'")
    expect(router).toContain('export const MAX_UPLOAD_BYTES = boundedByteLimit(')
    expect(router).toContain('process.env.MAX_UPLOAD_BYTES')
    expect(router).toContain('limits: { fileSize: MAX_UPLOAD_BYTES }')
    expect(router).not.toContain('Number(process.env.MAX_UPLOAD_BYTES')
  })

  it('bounds internal artifact fetch byte limits before reading MinIO objects', () => {
    const router = source('src/modules/internal/artifact-fetch.router.ts')

    expect(router).toContain("import { boundedByteLimit } from '../../lib/env-limits'")
    expect(router).toContain('export const INTERNAL_ARTIFACT_FETCH_MAX_BYTES = boundedByteLimit(')
    expect(router).toContain('process.env.INTERNAL_ARTIFACT_FETCH_MAX_BYTES')
    expect(router).toContain('maxBytes: z.number().int().positive().max(256_000).optional()')
    expect(router).toContain('body.maxBytes ?? INTERNAL_ARTIFACT_FETCH_MAX_BYTES')
    expect(router).toContain('INTERNAL_ARTIFACT_FETCH_MAX_BYTES,')
    expect(router).not.toContain('Number(process.env.INTERNAL_ARTIFACT_FETCH_MAX_BYTES')
  })
})
