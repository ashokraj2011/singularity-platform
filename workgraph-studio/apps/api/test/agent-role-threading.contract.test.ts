/**
 * Contract: the node's role reaches context-fabric.
 *
 * CF picks a capability's world-model slice by role, so if `agent_role` never
 * leaves workgraph the whole layered world model silently degrades to the
 * capability-wide model for every run — no error, just worse grounding.
 *
 * The role is deliberately NOT a new designer field: `governedAgentRole` already
 * exists on the node config and the governed path already sends it. This wires
 * the same value into `run_context` so both routes carry it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const client = fs.readFileSync(path.join(root, 'src/lib/context-fabric/client.ts'), 'utf8')
const executor = fs.readFileSync(
  path.join(root, 'src/modules/workflow/runtime/executors/AgentTaskExecutor.ts'),
  'utf8',
)

describe('agent_role threading', () => {
  it('is a typed, optional field on ExecuteRunContext', () => {
    const shape = client.slice(client.indexOf('export interface ExecuteRunContext'))
    expect(shape).toMatch(/\n\s*agent_role\?: string/)
  })

  it('is optional so existing callers and older CF builds are unaffected', () => {
    expect(client).not.toMatch(/\n\s*agent_role: string(?!\s*\|)/)
  })

  it('is populated in the run_context from the node config', () => {
    const runContext = executor.slice(
      executor.indexOf('run_context: {'),
      executor.indexOf('run_context: {') + 3000,
    )
    expect(runContext).toMatch(
      /agent_role: typeof cfg\.governedAgentRole === 'string' \? cfg\.governedAgentRole : undefined/,
    )
  })

  it('reuses governedAgentRole rather than introducing a second role field', () => {
    // Two sources of truth for an agent's role would drift, and the governed
    // adapter already reads this one.
    expect(executor).toMatch(
      /agentRole: typeof cfg\.governedAgentRole === 'string' \? cfg\.governedAgentRole : undefined/,
    )
    expect(executor).not.toMatch(/cfg\.agentRole\b/)
  })
})
