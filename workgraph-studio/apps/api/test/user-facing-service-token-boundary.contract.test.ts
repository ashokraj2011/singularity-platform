import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { iamTokenKind, isNonUserIamTokenKind } from '../src/middleware/auth'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.')
}

describe('Workgraph user-facing service-token boundary', () => {
  it('classifies IAM non-user token kinds before local user mirroring', () => {
    expect(iamTokenKind(unsignedJwt({ sub: 'user-1' }))).toBeUndefined()
    expect(isNonUserIamTokenKind(unsignedJwt({ sub: 'user-1' }))).toBe(false)
    expect(isNonUserIamTokenKind(unsignedJwt({ sub: 'user-1', kind: 'user' }))).toBe(false)
    expect(isNonUserIamTokenKind(unsignedJwt({ sub: 'user-1', kind: 'device' }))).toBe(true)
    expect(isNonUserIamTokenKind(unsignedJwt({ sub: 'service:workgraph-api', kind: 'service' }))).toBe(true)
    expect(isNonUserIamTokenKind('not-a-jwt')).toBe(false)
  })

  it('does not mirror IAM service principals into local Workgraph users', () => {
    const auth = source('src/middleware/auth.ts')

    expect(auth).toContain('function isIamServicePrincipal')
    expect(auth).toContain("iamUser.id.startsWith('service:')")
    expect(auth).toContain('SERVICE_TOKEN_NOT_USER_AUTH')
    expect(auth).toContain('function iamTokenKind')
    expect(auth).toContain("kind !== 'user'")
    expect(auth).toContain('NON_USER_TOKEN_NOT_USER_AUTH')
    expect(auth.indexOf('if (isNonUserIamTokenKind(token))')).toBeLessThan(auth.indexOf('const mirrored = await mirrorIamUser(iamUser)'))
    expect(auth.indexOf('if (isIamServicePrincipal(iamUser))')).toBeLessThan(auth.indexOf('const mirrored = await mirrorIamUser(iamUser)'))
  })

  it('limits Platform Web service-token retries to read-only reference paths', () => {
    const route = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/workgraph/[...path]/route.ts'),
      'utf8',
    )

    expect(route).toContain('function allowsServiceTokenRetry')
    expect(route).toContain('req.method !== "GET" && req.method !== "HEAD"')
    expect(route).toContain('const callerAuth = req.headers.get("authorization") ?? ""')
    expect(route).toContain('!callerAuth.startsWith("Bearer ")')
    expect(route).toContain('suffix.startsWith("lookup/")')
    expect(route).toContain('suffix.startsWith("tool-registry/")')
    expect(route).toContain('!allowsServiceTokenRetry(req, suffix)')
    expect(route).toContain('requireVerifiedCallerBearer(req, "Workgraph")')
    const serviceTokenAssignment = route.search(/const serviceToken(?:Result)? = await getServiceToken\(\)/)
    expect(serviceTokenAssignment).toBeGreaterThanOrEqual(0)
    expect(route.indexOf('requireVerifiedCallerBearer(req, "Workgraph")')).toBeLessThan(serviceTokenAssignment)
  })

  it('requires caller authorization before Platform Web injects privileged service tokens', () => {
    const proxy = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/_proxy.ts'),
      'utf8',
    )
    const codegen = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/codegen/[...path]/route.ts'),
      'utf8',
    )
    const auditGov = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/audit-gov/[...path]/route.ts'),
      'utf8',
    )
    const composer = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/prompt-workbench/_shared/composer.ts'),
      'utf8',
    )
    const llmSettings = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/llm-settings/route.ts'),
      'utf8',
    )
    const runtimeInfrastructure = readFileSync(
      path.resolve(__dirname, '../../../../agent-and-tools/web/src/app/api/runtime-infrastructure/route.ts'),
      'utf8',
    )

    expect(proxy).toContain('export function requireCallerBearer')
    expect(proxy).toContain('export async function requireVerifiedCallerBearer')
    expect(proxy).toContain('req.headers.get("authorization")')
    expect(proxy).toContain('auth.startsWith("Bearer ")')
    expect(proxy).toContain('/auth/verify')
    expect(proxy).toContain('/me')
    expect(proxy).toContain('code: "AUTH_REQUIRED"')
    expect(proxy).toContain('code: status === 401 ? "AUTH_INVALID" : "AUTH_VERIFY_UNAVAILABLE"')
    expect(codegen).toContain('requireVerifiedCallerBearer(req, "Code Foundry")')
    expect(codegen.indexOf('requireVerifiedCallerBearer(req, "Code Foundry")')).toBeLessThan(codegen.indexOf('proxyRequest(req, upstream, headers'))
    expect(codegen).not.toContain('headers.set("authorization", `Bearer ${token}`)')
    // audit-gov uses the identity-returning variant so it can scope the read to
    // the caller's tenant. requireVerifiedCallerBearer is now a wrapper around
    // it, so the boundary this test guards — verify the caller BEFORE injecting
    // the privileged service token — is unchanged.
    expect(proxy).toContain('export async function verifyCallerBearer')
    expect(auditGov).toContain('verifyCallerBearer(req, "Audit Governance")')
    expect(auditGov.indexOf('verifyCallerBearer(req, "Audit Governance")')).toBeLessThan(auditGov.indexOf('headers.set("authorization", `Bearer ${token}`)'))
    expect(composer).toContain('requireVerifiedCallerBearer(request, "Prompt Composer")')
    expect(composer.indexOf('requireVerifiedCallerBearer(request, "Prompt Composer")')).toBeLessThan(composer.indexOf('if (composerServiceToken()) return null'))
    expect(llmSettings).toContain('requireVerifiedCallerBearer(request, "LLM settings")')
    expect(llmSettings.indexOf('requireVerifiedCallerBearer(request, "LLM settings")')).toBeLessThan(llmSettings.indexOf('llmGatewayGet("/llm/providers")'))
    expect(runtimeInfrastructure).toContain('requireVerifiedCallerBearer(request, "Runtime infrastructure")')
    expect(runtimeInfrastructure.indexOf('requireVerifiedCallerBearer(request, "Runtime infrastructure")')).toBeLessThan(runtimeInfrastructure.indexOf('Promise.all(entries.map(probe))'))
  })
})
