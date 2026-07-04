import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workflow best-effort upstream response contracts', () => {
  it('degrades Copilot prompt composition and SSE call lookup with guarded parsing', () => {
    const router = source('src/modules/workflow/instances.router.ts')

    expect(router).toContain('type WorkflowJsonRead<T>')
    expect(router).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(router).toContain("import { copilotComposeTimeoutMs } from './copilot-compose-config'")
    expect(router).toContain('async function readWorkflowJsonResponse<T>(response: globalThis.Response, source: string): Promise<WorkflowJsonRead<T>>')
    expect(router).toContain('const body = await readUpstreamJsonBody(response)')
    expect(router).toContain('const timeoutMs = copilotComposeTimeoutMs()')
    expect(router).toContain('context-fabric prompt composition')
    expect(router).toContain('context-fabric invalid call lookup response')
    expect(router).not.toContain('Number(process.env.COPILOT_COMPOSE_TIMEOUT_MS ?? 30000)')
    expect(router).not.toMatch(/await resp\.json\(\)/)
    expect(router).not.toMatch(/await callsResp\.json\(\)/)
    expect(router).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('keeps Workbench Copilot handoff prompt composition fail-soft', () => {
    const router = source('src/modules/blueprint/blueprint.router.ts')

    expect(router).toContain("const body = await readJsonResponseBody(resp, 'context-fabric workbench prompt composition')")
    expect(router).toContain('const prompt = isJsonObject(body) ? body.prompt : undefined')
    expect(router).not.toMatch(/await resp\.json\(\)/)
  })

  it('skips optional prompt citations and learning writes on malformed upstream responses', () => {
    const insights = source('src/modules/workflow/insights.router.ts')
    const learning = source('src/lib/learning/record-run-learning.ts')

    expect(insights).toContain("import { isJsonObject, readUpstreamJsonBody } from '../../lib/upstream-json'")
    expect(insights).toContain('async function readInsightJsonObject<T>(response: globalThis.Response, source: string): Promise<T | null>')
    expect(insights).toContain('const body = await readUpstreamJsonBody(response)')
    expect(insights).toContain("const body = await readInsightJsonObject<{ data?: { evidenceRefs?: unknown } }>(resp, 'prompt assembly citations')")
    expect(insights).toContain('const parsedBody = await readUpstreamJsonBody(cf)')
    expect(insights).not.toMatch(/await resp\.json\(\)/)
    expect(insights).not.toMatch(/JSON\.parse\(raw\)/)
    expect(insights).not.toMatch(/JSON\.parse\(text\)/)

    expect(learning).toContain('async function readRuntimePostBody(res: Response, path: string): Promise<{ data?: { id?: string } } | null>')
    expect(learning).toContain("import { isJsonObject, readUpstreamJsonBody } from '../upstream-json'")
    expect(learning).toContain('const body = await readUpstreamJsonBody(res)')
    expect(learning).toContain('POST ${path} returned invalid JSON')
    expect(learning).toContain('const json = await readRuntimePostBody(res, path)')
    expect(learning).not.toMatch(/res\.json\(\)\.catch/)
    expect(learning).not.toMatch(/JSON\.parse\(raw\)/)
  })
})
