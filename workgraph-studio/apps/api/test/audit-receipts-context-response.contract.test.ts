import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph receipt timeline Context Fabric response contract', () => {
  it('treats live Context Fabric receipts as optional and JSON-ish', () => {
    const router = source('src/modules/audit/receipts.router.ts')

    expect(router).toContain('type ContextFabricReceiptsBody')
    expect(router).toContain("import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(router).toContain('async function readContextFabricReceiptsBody(res: Response): Promise<ContextFabricReceiptsBody>')
    expect(router).toContain('const body = await readUpstreamJsonBody(res)')
    expect(router).toContain('const body = await readContextFabricReceiptsBody(res)')
    expect(router).toContain('if (body.parseError || !Array.isArray(body.receipts)) return []')
    expect(router).toContain('includeCf ? cfReceipts(traceId) : Promise.resolve([])')
    expect(router).not.toMatch(/await res\.json\(\)/)
    expect(router).not.toMatch(/JSON\.parse\(text\)/)
  })
})
