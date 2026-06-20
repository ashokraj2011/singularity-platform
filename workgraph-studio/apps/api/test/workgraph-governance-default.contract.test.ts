import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const STRONG = 'prod_contract_secret_abcdefghijklmnopqrstuvwxyz123456'

function runConfig(extraEnv: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "const { config } = require('./src/config'); console.log(config.DEFAULT_GOVERNANCE_MODE)",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        APP_ENV: '',
        ENVIRONMENT: '',
        SINGULARITY_ENV: '',
        DATABASE_URL: 'postgresql://test:test@localhost:5434/test',
        JWT_SECRET: STRONG,
        MCP_BEARER_TOKEN: STRONG,
        WORKGRAPH_INTERNAL_TOKEN: STRONG,
        WORKGRAPH_INCOMING_EVENT_SECRETS: JSON.stringify({ 'agent-runtime': STRONG }),
        CONTEXT_FABRIC_SERVICE_TOKEN: STRONG,
        AUTH_PROVIDER: 'iam',
        IAM_SERVICE_TOKEN: STRONG,
        TENANT_ISOLATION_MODE: 'strict',
        DEFAULT_GOVERNANCE_MODE: 'fail_closed',
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  )
}

function runDevConfig(extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "const { config } = require('./src/config'); console.log(JSON.stringify({ forceGoverned: config.WORKGRAPH_FORCE_GOVERNED_CODING, sideCallers: config.CONTEXT_FABRIC_GOVERN_SIDE_CALLERS }))",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://test:test@localhost:5434/test',
        JWT_SECRET: STRONG,
        MCP_BEARER_TOKEN: STRONG,
        WORKGRAPH_INTERNAL_TOKEN: STRONG,
        CONTEXT_FABRIC_SERVICE_TOKEN: STRONG,
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  )
}

function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  return JSON.parse(lines[lines.length - 1] ?? '{}')
}

describe('Workgraph platform governance defaults', () => {
  it('defaults non-blueprint workflow agent tasks to governed execution', () => {
    const defaults = runDevConfig()
    expect(defaults.status).toBe(0)
    expect(parseLastJsonLine(defaults.stdout)).toMatchObject({ forceGoverned: true, sideCallers: true })

    const explicitRecoveryOptOut = runDevConfig({ WORKGRAPH_FORCE_GOVERNED_CODING: 'false' })
    expect(explicitRecoveryOptOut.status).toBe(0)
    expect(parseLastJsonLine(explicitRecoveryOptOut.stdout)).toMatchObject({ forceGoverned: false, sideCallers: true })

    const explicitSideCallerOptOut = runDevConfig({ CONTEXT_FABRIC_GOVERN_SIDE_CALLERS: 'false' })
    expect(explicitSideCallerOptOut.status).toBe(0)
    expect(parseLastJsonLine(explicitSideCallerOptOut.stdout)).toMatchObject({ forceGoverned: true, sideCallers: false })

    const agentTask = readFileSync('src/modules/workflow/runtime/executors/AgentTaskExecutor.ts', 'utf8')
    const eventHorizon = readFileSync('src/modules/event-horizon/event-horizon.router.ts', 'utf8')
    const configSource = readFileSync('src/config.ts', 'utf8')
    expect(configSource).toContain('function envBool(defaultValue: boolean)')
    expect(configSource).not.toContain('z.coerce.boolean()')
    expect(agentTask).toContain('cfg.useGovernedExecutor !== false')
    expect(agentTask).toContain('contextFabricClient.executeGovernedStage')
    expect(agentTask).toContain('result = await contextFabricClient.execute(executeReq)')
    expect(eventHorizon).toContain('contextFabricClient.executeGovernedTurn')
    expect(eventHorizon).toContain('The legacy /execute')
  })

  it('requires fail-closed default governance in production-class envs', () => {
    const ok = runConfig({})
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('fail_closed')

    const bad = runConfig({ DEFAULT_GOVERNANCE_MODE: 'fail_open' })
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('DEFAULT_GOVERNANCE_MODE')

    const missingIncomingSecrets = runConfig({ WORKGRAPH_INCOMING_EVENT_SECRETS: '' })
    expect(missingIncomingSecrets.status).not.toBe(0)
    expect(missingIncomingSecrets.stderr).toContain('WORKGRAPH_INCOMING_EVENT_SECRETS')
  })

  it('requires HMAC-signed incoming cross-service events', () => {
    const incoming = readFileSync('src/modules/audit/incoming-events.router.ts', 'utf8')

    expect(incoming).toContain('config.WORKGRAPH_INCOMING_EVENT_SECRETS')
    expect(incoming).toContain("return res.status(400).json({ code: 'BAD_REQUEST', message: 'envelope.source_service is required' })")
    expect(incoming).toContain("return res.status(401).json({ code: 'UNTRUSTED_SOURCE'")
    expect(incoming).toContain("return res.status(401).json({ code: 'BAD_SIGNATURE'")
    expect(incoming).not.toContain('if (secret) {')
    expect(incoming).not.toContain('Without a secret it accepts any caller')
  })

  it('does not hard-code implicit workflow/workbench defaults to fail_open', () => {
    const budget = readFileSync('src/modules/workflow/runtime/budget.ts', 'utf8')
    const agentTask = readFileSync('src/modules/workflow/runtime/executors/AgentTaskExecutor.ts', 'utf8')
    const blueprint = readFileSync('src/modules/blueprint/blueprint.router.ts', 'utf8')
    const contracts = readFileSync('src/modules/contracts/contracts.router.ts', 'utf8')
    const governedAdapter = readFileSync('src/modules/workflow/runtime/executors/governed-execute-adapter.ts', 'utf8')

    expect(budget).toContain('governanceMode: config.DEFAULT_GOVERNANCE_MODE as GovernanceMode')
    expect(agentTask).toContain('return config.DEFAULT_GOVERNANCE_MODE as GovernanceMode')
    expect(blueprint).toContain('return config.DEFAULT_GOVERNANCE_MODE as GovernanceMode')
    expect(blueprint).toContain(": config.DEFAULT_GOVERNANCE_MODE as NonNullable<LoopState['executionConfig']>['governanceMode']")
    expect(contracts).toContain('governance_mode: config.DEFAULT_GOVERNANCE_MODE')
    expect(contracts).not.toContain("governance_mode: 'fail_open'")
    expect(governedAdapter).toContain('const governanceMode = opts.governanceMode ?? config.DEFAULT_GOVERNANCE_MODE as GovernanceMode')
    expect(governedAdapter).not.toContain("opts.governanceMode ?? 'fail_open'")
    expect(governedAdapter).not.toContain("governanceMode: 'fail_open' as const")
  })

  it('replays immutable contracts through the governed verbatim prompt path', () => {
    const contracts = readFileSync('src/modules/contracts/contracts.router.ts', 'utf8')

    expect(contracts).toContain('renderFrozenReplayPrompt')
    expect(contracts).toContain('promptLayerVersions')
    expect(contracts).toContain('contentSnapshot')
    expect(contracts).toContain('systemPromptVersions')
    expect(contracts).toContain('stageBindingVersions')
    expect(contracts).toContain('toolPins')
    expect(contracts).toContain('bundleHash')
    expect(contracts).toContain('provider: contract.modelResolution?.provider')
    expect(contracts).toContain('model: contract.modelResolution?.model')
    expect(contracts).toContain('contextFabricClient.executeGovernedTurn')
    expect(contracts).toContain("source_type: 'immutable-contract-replay'")
    expect(contracts).toContain('originalRunId')
    expect(contracts).toContain('buildReplayDiff')
    expect(contracts).toContain('assertAgentRunTenant(req, originalRunId)')
    expect(contracts).toContain("outputType: 'LLM_RESPONSE'")
    expect(contracts).toContain('sha256Text')
    expect(contracts).not.toContain('contextFabricClient.execute({')
    expect(contracts).not.toContain('__replayContractId')
    expect(contracts).not.toContain('side-by-side diff is M40.2 follow-on')
  })

  it('routes direct MCP workflow tools through Context Fabric operational grants', () => {
    const grantHelper = readFileSync('src/modules/workflow/runtime/executors/mcpToolGrant.ts', 'utf8')
    const runPython = readFileSync('src/modules/workflow/runtime/executors/RunPythonExecutor.ts', 'utf8')
    const gitPush = readFileSync('src/modules/workflow/runtime/executors/GitPushExecutor.ts', 'utf8')

    expect(grantHelper).toContain('/internal/mcp/tool-grants')
    expect(grantHelper).toContain("'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN")
    expect(grantHelper).toContain("mode === 'enforce'")

    expect(runPython).toContain("requestOperationalMcpToolGrant")
    expect(runPython).toContain("toolName: 'run_python'")
    expect(runPython).toContain("...(toolGrant ? { tool_grant: toolGrant } : {})")

    expect(gitPush).toContain("toolName: 'finish_work_branch'")
    expect(gitPush).toContain("approvalStatus: args.approvalStatus")
    expect(gitPush).toContain("...(toolGrant ? { tool_grant: toolGrant } : {})")
  })
})
