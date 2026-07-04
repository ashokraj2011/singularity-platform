import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph -> Audit Governance response contract', () => {
  it('normalizes JSON/plaintext bodies in the shared audit-gov client', () => {
    const client = source('src/lib/audit-gov/client.ts')

    expect(client).toContain("import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'")
    expect(client).toContain('async function readAuditGovBody(res: Response): Promise<AuditGovBody>')
    expect(client).toContain('return readUpstreamJsonBody(res)')
    expect(client).toContain('function auditGovErrorText(path: string, status: number, body: AuditGovBody')
    expect(client).toContain('audit-gov ${path} returned invalid JSON')
    expect(client).toContain('const body = await readAuditGovBody(res)')
    expect(client).toContain('const responseBody = await readAuditGovBody(res)')
    expect(client).toContain('if (body.parseError)')
    expect(client).toContain('if (responseBody.parseError)')
    expect(client).not.toMatch(/await res\.json\(\)/)
    expect(client).not.toMatch(/JSON\.parse\(text\)/)
    expect(client).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('keeps fail-soft and strict helper semantics distinct', () => {
    const client = source('src/lib/audit-gov/client.ts')

    expect(client).toMatch(/async function getJson<T>[\s\S]*?return null[\s\S]*?return body\.data as T/)
    expect(client).toMatch(/export async function postJson<T>[\s\S]*?return null[\s\S]*?return responseBody\.data as T/)
    expect(client).toMatch(/export async function getJsonStrict<T>[\s\S]*?status: 502[\s\S]*?errorText: auditGovErrorText/)
    expect(client).toMatch(/export async function patchJsonStrict<T>[\s\S]*?status: 502[\s\S]*?errorText: auditGovErrorText/)
  })
})
