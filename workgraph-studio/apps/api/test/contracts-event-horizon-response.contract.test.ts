import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Contracts and Event Horizon proxy response contracts', () => {
  it('normalizes Prompt Composer contract proxy responses before use', () => {
    const router = source('src/modules/contracts/contracts.router.ts')

    expect(router).toContain('type ComposerEnvelope<T = unknown>')
    expect(router).toContain('async function readComposerEnvelope<T = unknown>(response: globalThis.Response, source: string): Promise<ComposerEnvelope<T>>')
    expect(router).toContain('returned a non-object JSON body')
    expect(router).toContain("const json = await readComposerEnvelope(r, 'composer contracts fetch')")
    expect(router).toContain("const json = await readComposerEnvelope(r, 'composer contract fetch')")
    expect(router).toContain("const contractEnvelope = await readComposerEnvelope<ContractBundle>(cr, 'composer contract replay fetch')")
    expect(router).toContain("error: 'composer contracts invalid response'")
    expect(router).toContain("error: 'composer contract invalid response'")
    expect(router).toContain("error: 'contract fetch invalid response'")
    expect(router).not.toMatch(/await r\.json\(\)/)
    expect(router).not.toMatch(/await cr\.json\(\)/)
  })

  it('normalizes Prompt Composer Event Horizon actions responses before use', () => {
    const router = source('src/modules/event-horizon/event-horizon.router.ts')

    expect(router).toContain('type ComposerActionEnvelope')
    expect(router).toContain('async function readComposerActionEnvelope(response: Response): Promise<ComposerActionEnvelope>')
    expect(router).toContain('Prompt Composer actions returned a non-object JSON body')
    expect(router).toContain('const json = await readComposerActionEnvelope(r)')
    expect(router).toContain("error: 'composer actions invalid response'")
    expect(router).not.toMatch(/await r\.json\(\)/)
  })
})
