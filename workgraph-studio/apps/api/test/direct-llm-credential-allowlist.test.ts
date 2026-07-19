/**
 * Contract: the credential allowlist applies to the value actually used.
 *
 * `credentialEnv` has two sources — node config and the tenant's llmConnection
 * row — and the CONNECTION WINS. The allowlist only ran at config-parse time, so
 * the higher-precedence value reached `process.env[...]` unchecked: a connection
 * row naming any env var could read that secret into a provider call.
 *
 * `baseUrl` never had this hole; it is validated after the same merge. This pins
 * the parallel invariant for credentials.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { credentialEnvAllowed, directLlmEgressAllowed } from '../src/modules/workflow/runtime/executors/direct-llm-config'

const ORIGINAL = process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS
  else process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS = ORIGINAL
})

describe('direct LLM credential allowlist', () => {
  it('permits the shipped provider keys by default', () => {
    delete process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS
    for (const name of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(credentialEnvAllowed(name)).toBe(true)
    }
  })

  it('refuses anything else', () => {
    delete process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS
    for (const name of ['MY_UNSAFE_KEY', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'JWT_SECRET']) {
      expect(credentialEnvAllowed(name)).toBe(false)
    }
  })

  it('is configurable, and the override replaces the default set', () => {
    process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS = 'ANTHROPIC_API_KEY'
    expect(credentialEnvAllowed('ANTHROPIC_API_KEY')).toBe(true)
    expect(credentialEnvAllowed('OPENAI_API_KEY')).toBe(false)
  })

  it('ignores whitespace and blanks in the override', () => {
    process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS = ' ANTHROPIC_API_KEY , , OPENAI_API_KEY '
    expect(credentialEnvAllowed('ANTHROPIC_API_KEY')).toBe(true)
    expect(credentialEnvAllowed('OPENAI_API_KEY')).toBe(true)
    expect(credentialEnvAllowed('')).toBe(false)
  })

  it('fails CLOSED when the override is empty', () => {
    // An empty allowlist permits NOTHING. `?? default` does not fire for an
    // empty string, so the set is genuinely empty rather than silently reverting
    // to the shipped defaults -- an operator who blanks this disables direct LLM
    // rather than quietly widening it.
    process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS = ''
    expect(credentialEnvAllowed('ANTHROPIC_API_KEY')).toBe(false)
    expect(credentialEnvAllowed('OPENAI_API_KEY')).toBe(false)
  })

  it('is applied to the merged value in the resolver, not just to node config', () => {
    // The connection row wins over node config, so the check must run AFTER the
    // merge. Asserted structurally: the resolver reads the merged credentialEnv
    // and gates on it before any provider call.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/workflow/runtime/executors/DirectLlmTaskExecutor.ts'),
      'utf8',
    )
    expect(src).toMatch(
      /const credentialEnv = connection\?\.credentialEnv \?\? cfgString\(effectiveNode, 'credentialEnv'\)[\s\S]{0,600}?if \(credentialEnv && !credentialEnvAllowed\(credentialEnv\)\)/,
    )
    expect(src).toMatch(/DIRECT_LLM_CREDENTIAL_ENV_BLOCKED/)
  })
})

describe('direct LLM egress policy', () => {
  const ORIGINAL_POLICY = process.env.WORKGRAPH_ALLOW_DIRECT_LLM

  afterEach(() => {
    if (ORIGINAL_POLICY === undefined) delete process.env.WORKGRAPH_ALLOW_DIRECT_LLM
    else process.env.WORKGRAPH_ALLOW_DIRECT_LLM = ORIGINAL_POLICY
  })

  it('defaults to ALLOWED', () => {
    // Unlike context-fabric's direct route, this executor has no alternative
    // egress to fall through to. Defaulting off would break every
    // DIRECT_LLM_TASK rather than reroute it, so the default preserves
    // behaviour and the flag is an opt-in policy control.
    delete process.env.WORKGRAPH_ALLOW_DIRECT_LLM
    expect(directLlmEgressAllowed()).toBe(true)
    process.env.WORKGRAPH_ALLOW_DIRECT_LLM = ''
    expect(directLlmEgressAllowed()).toBe(true)
  })

  it('can be turned off so direct egress fails loudly', () => {
    for (const off of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) {
      process.env.WORKGRAPH_ALLOW_DIRECT_LLM = off
      expect(directLlmEgressAllowed()).toBe(false)
    }
  })

  it('treats anything else as allowed rather than silently blocking', () => {
    for (const on of ['true', '1', 'yes', 'on', 'anything']) {
      process.env.WORKGRAPH_ALLOW_DIRECT_LLM = on
      expect(directLlmEgressAllowed()).toBe(true)
    }
  })

  it('gates BOTH egress choke points, not just one', () => {
    // All four provider fetch sites funnel through exactly two functions:
    // callProvider (harness path) and defaultCallToolProvider (tool-loop path).
    // Gating only one would leave half the bypass open.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dir = path.join(process.cwd(), 'src/modules/workflow/runtime/executors')

    const executor = fs.readFileSync(path.join(dir, 'DirectLlmTaskExecutor.ts'), 'utf8')
    expect(executor).toMatch(/async function callProvider\([\s\S]{0,900}?if \(!directLlmEgressAllowed\(\)\)/)

    const toolLoop = fs.readFileSync(path.join(dir, 'DirectLlmToolLoop.ts'), 'utf8')
    expect(toolLoop).toMatch(/export async function defaultCallToolProvider\([\s\S]{0,600}?if \(!directLlmEgressAllowed\(\)\)/)
  })

  it('lets mock through in both paths, since it opens no socket', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dir = path.join(process.cwd(), 'src/modules/workflow/runtime/executors')

    // The mock early-return must come BEFORE the gate, or offline tests break.
    const toolLoop = fs.readFileSync(path.join(dir, 'DirectLlmToolLoop.ts'), 'utf8')
    const body = toolLoop.slice(toolLoop.indexOf('export async function defaultCallToolProvider('))
    expect(body.indexOf("provider === 'mock'")).toBeLessThan(body.indexOf('directLlmEgressAllowed'))
  })
})
