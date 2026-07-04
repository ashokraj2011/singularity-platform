import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('formal verifier upstream response contract', () => {
  it('normalizes verifier response bodies before workflow evidence uses them', () => {
    const formal = source('src/modules/workflow/formal-verification.ts')

    expect(formal).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(formal).toContain('async function readVerifierJsonObject(res: Response, source: string)')
    expect(formal).toContain('const body = await readUpstreamJsonBody(res)')
    expect(formal).toContain("invalidReason: 'non-object JSON response'")
    expect(formal).toContain('FORMAL_VERIFIER_BAD_RESPONSE')
    expect(formal).toContain('verifierMessage(body.parsed')
    expect(formal).toContain('verifierCode(body.parsed')
    expect(formal).not.toMatch(/JSON\.parse\(body\)/)
    expect(formal).not.toMatch(/JSON\.parse\(raw\)/)
    expect(formal).not.toMatch(/return parsed\s*$/m)
  })
})
