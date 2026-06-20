import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('connector outbound URL policy', () => {
  it('validates Slack and Teams webhook URLs before outbound posts', () => {
    const teams = source('src/modules/connectors/adapters/teams.adapter.ts')
    const slack = source('src/modules/connectors/adapters/slack.adapter.ts')

    expect(teams).toContain("import { assertEventTargetUrlAllowed } from '../../../lib/eventbus/target-url-policy'")
    expect(teams).toContain('const safeUrl = await assertEventTargetUrlAllowed(webhookUrl)')
    expect(teams).toContain('const safeUrl = await assertEventTargetUrlAllowed(url)')
    expect(teams).toContain('axios.post(safeUrl.toString()')
    expect(teams).not.toContain('axios.post(webhookUrl,')
    expect(teams).not.toContain('axios.post(url,')

    expect(slack).toContain("import { assertEventTargetUrlAllowed } from '../../../lib/eventbus/target-url-policy'")
    expect(slack).toContain('const safeUrl = await assertEventTargetUrlAllowed(this.creds.webhookUrl)')
    expect(slack).toContain('const safeUrl = await assertEventTargetUrlAllowed(url)')
    expect(slack).toContain('axios.post(safeUrl.toString()')
    expect(slack).not.toContain('axios.post(this.creds.webhookUrl,')
    expect(slack).not.toContain('axios.post(url,')
  })

  it('validates generic HTTP connector base URLs and rejects absolute path overrides', () => {
    const http = source('src/modules/connectors/adapters/http.adapter.ts')

    expect(http).toContain("import { assertEventTargetUrlAllowed } from '../../../lib/eventbus/target-url-policy'")
    expect(http).toContain('const safeBaseUrl = await assertEventTargetUrlAllowed(this.config.baseUrl)')
    expect(http).toContain('baseURL: safeBaseUrl.toString()')
    expect(http).toContain("throw new Error('HTTP connector path must be relative to the configured baseUrl')")
    expect(http).not.toContain('baseURL: this.config.baseUrl')
  })

  it('constrains the compatibility LLM connector to local MCP or vetted HTTPS remotes', () => {
    const llm = source('src/modules/connectors/adapters/llm-gateway.adapter.ts')

    expect(llm).toContain('const LOCAL_MCP_HOSTS = new Set')
    expect(llm).toContain("'mcp-server'")
    expect(llm).toContain("'host.docker.internal'")
    expect(llm).toContain('parsed.username || parsed.password')
    expect(llm).toContain('const safePublicUrl = await assertEventTargetUrlAllowed(parsed.toString())')
    expect(llm).toContain("throw new Error('Remote LLM Gateway connector baseUrl must use https')")
    expect(llm).toContain('baseURL: await this.safeBaseUrl()')
    expect(llm).not.toContain('baseURL: this.config.baseUrl')
  })
})
