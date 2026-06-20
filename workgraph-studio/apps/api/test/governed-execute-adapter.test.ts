/**
 * Task #119 — unit tests for the workflow→governed adapter.
 *
 * The adapter is the thinnest possible piece of the governed migration:
 * it just translates request/response shapes. Even so, both directions
 * have small "did we fold the legacy fields correctly" decisions that
 * deserve a regression net. AgentTaskExecutor's integration test
 * eventually catches the rest; this file is fast + pure.
 */
import { describe, it, expect } from 'vitest'
import {
  executeReqToGovernedStageReq,
  governedStageRespToExecuteResp,
} from '../src/modules/workflow/runtime/executors/governed-execute-adapter'
import type {
  ExecuteRequest,
  GovernedStageResponse,
} from '../src/lib/context-fabric/client'
import { config } from '../src/config'

describe('#119 — executeReqToGovernedStageReq', () => {
  it('uses loop.stage as default stage_key when caller does not override', () => {
    const out = executeReqToGovernedStageReq({
      task: 'do the thing',
      run_context: { workflow_instance_id: 'w-1' },
    } as ExecuteRequest)
    expect(out.stage_key).toBe('loop.stage')
    expect(out.agent_role).toBeUndefined()
  })

  it('respects caller stage_key/agent_role/max_turns overrides', () => {
    const out = executeReqToGovernedStageReq(
      { task: '', run_context: {} } as unknown as ExecuteRequest,
      { stageKey: 'custom.stage', agentRole: 'DESIGNER', maxTurns: 50 },
    )
    expect(out.stage_key).toBe('custom.stage')
    expect(out.agent_role).toBe('DESIGNER')
    expect(out.max_turns).toBe(50)
  })

  it('folds legacy task + system_prompt + globals into vars', () => {
    const out = executeReqToGovernedStageReq({
      task: 'main user input',
      system_prompt: 'be concise',
      globals: { language: 'java' },
      vars: { existing: 1 },
      run_context: {},
    } as unknown as ExecuteRequest)
    expect(out.vars.task).toBe('main user input')
    expect(out.vars.system_prompt).toBe('be concise')
    expect(out.vars.globals).toEqual({ language: 'java' })
    expect(out.vars.existing).toBe(1)
  })

  it('forwards model_overrides.modelAlias as governed-side model_alias', () => {
    const out = executeReqToGovernedStageReq({
      task: '',
      run_context: {},
      model_overrides: { modelAlias: 'mock-fast' },
    } as unknown as ExecuteRequest)
    expect(out.model_alias).toBe('mock-fast')
  })

  it('defaults max_turns to 25 when not specified', () => {
    const out = executeReqToGovernedStageReq({
      task: '', run_context: {},
    } as unknown as ExecuteRequest)
    expect(out.max_turns).toBe(25)
  })
})

describe('#119 — governedStageRespToExecuteResp', () => {
  const baseResp: GovernedStageResponse = {
    final_state: {
      stage_key: 'loop.stage',
      agent_role: 'DEVELOPER',
      current_phase: 'FINALIZE',
      repair_attempts: 0,
      receipts: {},
      history: [],
      approval_pending: false,
    },
    turns: [],
    stop_reason: 'FINALIZED',
    error_code: null,
    error_message: null,
    totals: {
      input_tokens: 1000,
      output_tokens: 500,
      tool_calls: 3,
      tools_refused: 0,
    },
  }

  it('maps FINALIZED → COMPLETED', () => {
    const out = governedStageRespToExecuteResp(baseResp)
    expect(out.status).toBe('COMPLETED')
    expect(out.finishReason).toBe('stop')
  })

  it('preserves the caller governance mode in the legacy response envelope', () => {
    const out = governedStageRespToExecuteResp(baseResp, { governanceMode: 'fail_closed' })

    expect(out.governanceMode).toBe('fail_closed')
    expect(out.correlation.governanceMode).toBe('fail_closed')
  })

  it('falls back to the configured governance default when caller mode is missing', () => {
    const out = governedStageRespToExecuteResp(baseResp)

    expect(out.governanceMode).toBe(config.DEFAULT_GOVERNANCE_MODE)
    expect(out.correlation.governanceMode).toBe(config.DEFAULT_GOVERNANCE_MODE)
  })

  it('maps MAX_TURNS → FAILED + length finish_reason', () => {
    const out = governedStageRespToExecuteResp({ ...baseResp, stop_reason: 'MAX_TURNS' })
    expect(out.status).toBe('FAILED')
    expect(out.finishReason).toBe('length')
  })

  it('maps APPROVAL_PENDING → WAITING_APPROVAL and carries the PhaseState for resume', () => {
    // Regression: APPROVAL_PENDING used to map to COMPLETED, silently skipping
    // approvalRequired gates for governed agent tasks. It must pause instead, and
    // expose final_state so the caller can persist + resume it.
    const out = governedStageRespToExecuteResp({
      ...baseResp,
      stop_reason: 'APPROVAL_PENDING',
      final_state: { ...baseResp.final_state, current_phase: 'SELF_REVIEW', approval_pending: true },
    })
    expect(out.status).toBe('WAITING_APPROVAL')
    expect((out as { governedFinalState?: Record<string, unknown> }).governedFinalState).toMatchObject({
      current_phase: 'SELF_REVIEW',
      approval_pending: true,
    })
  })

  it('synthesises a cfCallId from stage_key + turn count', () => {
    const out = governedStageRespToExecuteResp({
      ...baseResp,
      turns: [{ turn_index: 0 } as never, { turn_index: 1 } as never],
    })
    expect(out.correlation.cfCallId).toBe('governed:loop.stage:2')
  })

  it('totals input + output tokens into the legacy tokensUsed shape', () => {
    const out = governedStageRespToExecuteResp(baseResp)
    expect(out.tokensUsed?.input).toBe(1000)
    expect(out.tokensUsed?.output).toBe(500)
    expect(out.tokensUsed?.total).toBe(1500)
  })

  it('aggregates tool_invocation_ids across turns', () => {
    const out = governedStageRespToExecuteResp({
      ...baseResp,
      turns: [
        {
          turn_index: 0,
          tool_outcomes: [{ tool_invocation_id: 'ti-1' } as never],
        } as never,
        {
          turn_index: 1,
          tool_outcomes: [
            { tool_invocation_id: 'ti-2' } as never,
            { tool_invocation_id: 'ti-3' } as never,
          ],
        } as never,
      ],
    })
    expect(out.correlation.toolInvocationIds).toEqual(['ti-1', 'ti-2', 'ti-3'])
  })

  it('surfaces error_message in warnings + blockedReason', () => {
    const out = governedStageRespToExecuteResp({
      ...baseResp,
      stop_reason: 'POLICY_BLOCKED',
      error_code: 'PHASE_TOOL_FORBIDDEN',
      error_message: 'tool X not allowed in phase Y',
    })
    expect(out.warnings).toContain('tool X not allowed in phase Y')
    expect(out.blockedReason).toBe('PHASE_TOOL_FORBIDDEN')
  })

  it('renders a Markdown finalResponse digest from receipts', () => {
    const out = governedStageRespToExecuteResp({
      ...baseResp,
      final_state: {
        ...baseResp.final_state,
        receipts: {
          PLAN: [{ summary: 'planned the change' }],
          ACT: [{ summary: 'made the edits' }],
        },
      },
    })
    expect(out.finalResponse).toContain('# Governed stage')
    expect(out.finalResponse).toContain('planned the change')
    expect(out.finalResponse).toContain('made the edits')
  })
})
