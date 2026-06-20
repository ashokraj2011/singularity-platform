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
    }
  })
})
