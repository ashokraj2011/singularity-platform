import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph -> Prompt Composer service auth contract', () => {
  it('centralizes Prompt Composer bearer headers on the IAM service token helper', () => {
    const client = source('src/lib/prompt-composer/client.ts')

    expect(client).toContain("import { getIamServiceToken } from '../iam/service-token'")
    expect(client).toContain('export async function promptComposerAuthHeaders')
    expect(client).toContain('authorization: `Bearer ${token}`')
    expect(client).toContain("headers: await promptComposerAuthHeaders({ 'content-type': 'application/json' })")
  })

  it('requires a Workgraph service token source in production-class environments', () => {
    const config = source('src/config.ts')

    expect(config).toContain("'IAM_SERVICE_TOKEN'")
    expect(config).toContain('process.env.IAM_BOOTSTRAP_USERNAME')
    expect(config).toContain('process.env.IAM_BOOTSTRAP_PASSWORD')
    expect(config).toContain('authenticate service-to-service calls to Prompt Composer')
  })

  it('keeps direct Prompt Composer proxy fetches behind the shared auth helper', () => {
    const directFiles = [
      'src/modules/event-horizon/event-horizon.router.ts',
      'src/modules/contracts/contracts.router.ts',
      'src/modules/workflow/insights.router.ts',
    ]

    for (const file of directFiles) {
      const text = source(file)
      expect(text, `${file} must import the shared Prompt Composer auth helper`).toContain('promptComposerAuthHeaders')
      expect(text, `${file} must attach Prompt Composer auth headers to fetches`).toContain('headers: await promptComposerAuthHeaders')
      expect(text, `${file} must use the shared upstream parser`).toContain('readUpstreamJsonBody')
      expect(text, `${file} must not parse upstream raw text inline`).not.toMatch(/JSON\.parse\(raw\)|JSON\.parse\(text\)/)
    }
  })

  it('normalizes Prompt Composer JSON/plaintext envelopes in the shared client', () => {
    const client = source('src/lib/prompt-composer/client.ts')

    expect(client).toContain("import { isJsonObject, readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'")
    expect(client).toContain('async function readPromptComposerBody(res: Response): Promise<PromptComposerBody>')
    expect(client).toContain('return readUpstreamJsonBody(res)')
    expect(client).toContain('function promptComposerDetail(body: PromptComposerBody): unknown')
    expect(client).toContain('async function readPromptComposerEnvelope<T>')
    expect(client).toContain('prompt-composer ${path} returned invalid JSON')
    expect(client).toContain("await readPromptComposerEnvelope<{ content: string; version: number }>(res, `/system-prompts/${key}`)")
    expect(client).toContain("const json = await readPromptComposerEnvelope<ComposeResponse>(res, '/compose-and-respond')")
    expect(client).toContain("const json = await readPromptComposerEnvelope<ResolveStageResponse>(res, '/stage-prompts/resolve')")
    expect(client).toContain("if (!json.data) throw new PromptComposerError('prompt-composer returned success=true without data'")
    expect(client).toContain("if (!json.data) throw new PromptComposerError('prompt-composer stage resolve returned success=true without data'")
    expect(client).not.toMatch(/await res\.json\(\)/)
    expect(client).not.toMatch(/JSON\.parse\(text\)/)
    expect(client).not.toMatch(/JSON\.parse\(raw\)/)
  })
})
