import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('IAM service-token bootstrap response contract', () => {
  it('parses IAM bootstrap and service-token mint responses defensively', () => {
    const serviceToken = source('src/lib/iam/service-token.ts')

    expect(serviceToken).toContain('async function readIamTokenJson(res: Response, source: string): Promise<Record<string, unknown> | null>')
    expect(serviceToken).toContain("import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../upstream-json'")
    expect(serviceToken).toContain('const body = await readUpstreamJsonBody(res)')
    expect(serviceToken).toContain('returned an empty response')
    expect(serviceToken).toContain('returned a non-object JSON response')
    expect(serviceToken).toContain('returned invalid JSON')
    expect(serviceToken).toContain('function accessTokenFromBody(body: Record<string, unknown> | null, source: string): string | undefined')
    expect(serviceToken).toContain("const loginBody = await readIamTokenJson(loginRes, 'bootstrap login')")
    expect(serviceToken).toContain("const userJwt = accessTokenFromBody(loginBody, 'bootstrap login')")
    expect(serviceToken).toContain("const body = await readIamTokenJson(mintRes, 'service-token mint')")
    expect(serviceToken).toContain("const svcJwt = accessTokenFromBody(body, 'service-token mint')")
    expect(serviceToken).not.toMatch(/await loginRes\.json\(\)/)
    expect(serviceToken).not.toMatch(/await mintRes\.json\(\)/)
    expect(serviceToken).not.toMatch(/JSON\.parse\(text\)/)
  })
})
