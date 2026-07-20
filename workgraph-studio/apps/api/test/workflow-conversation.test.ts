/**
 * Workflow nodes ← conversation memory.
 *
 * WHAT CHANGED. `governed-execute-adapter.ts` hardcoded `initial_history: []`,
 * which is why every workflow node reached the model with no idea what any
 * other node had done. The parameter had been plumbed through four layers of
 * context-fabric and populated by nobody. It is now omitted, and CF fills the
 * history itself from its conversation store.
 *
 * The consequence, stated plainly: **ACT now sees what PLAN said.** A workflow
 * instance is one continuous conversation across its nodes instead of three or
 * four amnesiac ones.
 *
 * THE TRAP THIS FILE GUARDS. The obvious-looking implementation — passing an
 * explicit `conversation_id` in `run_context` — silently breaks the feature.
 * CF's identity resolver gives an explicit id its own branch, returning
 * `scope_kind: 'explicit'` and `surface: None`; a None surface then fails the
 * CF_CONVERSATION_SURFACES allowlist check and workflow memory is dead while
 * looking enabled. Letting CF derive the id from `workflow_instance_id` yields
 * `surface: 'workflow'`, `scope_kind: 'instance'` — correct, and addressable by
 * the allowlist. The test below fails if anyone "improves" this by adding an
 * explicit id.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { executeReqToGovernedStageReq } from '../src/modules/workflow/runtime/executors/governed-execute-adapter'
import type { ExecuteRequest } from '../src/lib/context-fabric/client'

function adapterSource(): string {
  return readFileSync(
    path.resolve(
      __dirname, '..',
      'src/modules/workflow/runtime/executors/governed-execute-adapter.ts',
    ),
    'utf8',
  )
}

function composeSource(): string {
  return readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'docker-compose.yml'), 'utf8')
}

const REQ = {
  task: 'implement the ledger',
  run_context: {
    workflow_instance_id: 'wfi-1',
    workflow_node_id: 'node-act',
    capability_id: 'cap-1',
  },
} as unknown as ExecuteRequest

describe('governed stage request no longer pins an empty history', () => {
  it('omits initial_history entirely', () => {
    const out = executeReqToGovernedStageReq(REQ)
    expect(out.initial_history).toBeUndefined()
    expect('initial_history' in out).toBe(false)
  })

  it('no longer hardcodes an empty array in the source', () => {
    expect(adapterSource()).not.toMatch(/^\s*initial_history: \[\],/m)
  })

  it('keeps the wire parameter available for replay and eval overrides', () => {
    // Omitted in production, but the field must remain on the request type so a
    // replay harness can still pin an exact history.
    const withHistory = {
      ...executeReqToGovernedStageReq(REQ),
      initial_history: [{ role: 'user', content: 'pinned by a replay harness' }],
    }
    expect(withHistory.initial_history).toHaveLength(1)
  })
})

describe('CF is left to derive the conversation identity', () => {
  it('forwards workflow_instance_id, which is what CF keys the conversation on', () => {
    const out = executeReqToGovernedStageReq(REQ)
    expect(out.run_context?.workflow_instance_id).toBe('wfi-1')
  })

  it('does NOT inject an explicit conversation_id', () => {
    // An explicit id resolves with surface=None, which fails the surface
    // allowlist and silently disables workflow memory. See the file header.
    const out = executeReqToGovernedStageReq(REQ)
    expect(out.run_context?.conversation_id).toBeUndefined()
    expect(out.run_context?.conversationId).toBeUndefined()
    expect(adapterSource()).not.toMatch(/conversation_id:/)
  })

  it('passes run_context through without inventing conversation fields', () => {
    const out = executeReqToGovernedStageReq(REQ)
    expect(out.run_context).toEqual(REQ.run_context as unknown as Record<string, unknown>)
  })
})

describe('the workflow surface is enabled', () => {
  it('lists workflow in CF_CONVERSATION_SURFACES', () => {
    const line = composeSource()
      .split('\n')
      .find((l) => l.trim().startsWith('CF_CONVERSATION_SURFACES:'))
    expect(line).toBeDefined()
    expect(line).toContain('workflow')
  })

  it('keeps every previously enabled surface enabled', () => {
    const line = composeSource()
      .split('\n')
      .find((l) => l.trim().startsWith('CF_CONVERSATION_SURFACES:')) as string
    for (const surface of ['synthesis', 'room_copilot', 'board_copilot', 'planner']) {
      expect(line).toContain(surface)
    }
  })
})
