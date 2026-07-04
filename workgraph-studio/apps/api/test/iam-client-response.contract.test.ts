import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph IAM client response contract', () => {
  it('centralizes IAM JSON/plaintext parsing for auth, lookup, and governance calls', () => {
    const client = source('src/lib/iam/client.ts')

    expect(client).toContain('type IamBody')
    expect(client).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../upstream-json'")
    expect(client).toContain('async function readIamBody(res: Response): Promise<IamBody>')
    expect(client).toContain('const body = await readUpstreamJsonBody(res)')
    expect(client).toContain('function iamBodyPreview(body: IamBody): string')
    expect(client).toContain('async function readIamJson<T>(res: Response, path: string): Promise<T>')
    expect(client).toContain('async function iamResponseError(res: Response, path: string): Promise<string>')
    expect(client).not.toMatch(/await res\.json\(\)/)
    expect(client).not.toMatch(/return res\.json\(\)/)
    expect(client).not.toMatch(/JSON\.parse\(text\)/)
    expect(client).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('fails closed for malformed authz responses and fail-soft for optional IAM overlays', () => {
    const client = source('src/lib/iam/client.ts')

    expect(client).toMatch(/export async function authzCheck[\s\S]*?try \{[\s\S]*?readIamJson<IamAuthzCheckResponse>[\s\S]*?\} catch \(err\) \{[\s\S]*?allowed: false/)
    expect(client).toMatch(/export async function getCapability[\s\S]*?readIamJson<\{ id: string; name: string;[\s\S]*?\.catch\(\(\) => null\)[\s\S]*?return null/)
    expect(client).toMatch(/export async function resolveGovernance[\s\S]*?readIamJson<\{ success\?: boolean; data\?: Record<string, unknown> \}>[\s\S]*?\.catch\(\(\) => null\)/)
  })
})
