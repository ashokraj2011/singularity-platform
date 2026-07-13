// ─────────────────────────────────────────────────────────────────────────────
// Task executors — the service-bound "do work" nodes. Each reads its inputs from
// node config (falling back to bundled assets where relevant), calls the matching
// adapter, and degrades to BLOCKED when that adapter is offline so the run parks.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExecContext, ExecOutcome, NodeExecutor } from '../types.js'
import { OfflineError } from '../types.js'

function cfg(ctx: ExecContext): Record<string, unknown> {
  return (ctx.node.config ?? {}) as Record<string, unknown>
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function block(ctx: ExecContext, capability: string): ExecOutcome {
  ctx.log(`${capability}Deferred`, `offline — parking node`)
  return { kind: 'BLOCKED', reason: `awaiting ${capability} (offline)` }
}

export const llmTaskExecutor: NodeExecutor = {
  handles: ['DIRECT_LLM_TASK', 'AGENT_TASK'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const c = cfg(ctx)
    // Prompt precedence: inline config → bundled asset referenced by promptAsset.
    const promptAssetKey = str(c.promptAsset)
    const prompt =
      str(c.prompt) ??
      str(c.task) ??
      str(c.promptTemplate) ??
      (promptAssetKey ? ctx.assets[promptAssetKey] : undefined)
    if (!prompt) return { kind: 'FAILED', reason: 'LLM node has no prompt/task/promptAsset' }
    try {
      const res = await ctx.adapters.llm.complete({ prompt, model: str(c.model) })
      return { kind: 'COMPLETED', output: { text: res.text } }
    } catch (err) {
      if (err instanceof OfflineError) return block(ctx, 'llm')
      throw err
    }
  },
}

export const toolRequestExecutor: NodeExecutor = {
  handles: ['TOOL_REQUEST'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const c = cfg(ctx)
    const tool = str(c.toolId) ?? str(c.tool) ?? str(c.toolKey)
    if (!tool) return { kind: 'FAILED', reason: 'TOOL_REQUEST node has no toolId' }
    const params = (c.inputPayload as Record<string, unknown>) ?? (c.params as Record<string, unknown>) ?? {}
    try {
      const res = await ctx.adapters.tool.invoke({ tool, params })
      return { kind: 'COMPLETED', output: { result: res.result } }
    } catch (err) {
      if (err instanceof OfflineError) return block(ctx, 'tool')
      throw err
    }
  },
}

export const gitExecutor: NodeExecutor = {
  handles: ['GIT_PUSH', 'RAISE_PR', 'CREATE_BRANCH'],
  async execute(ctx: ExecContext): Promise<ExecOutcome> {
    const c = cfg(ctx)
    const vars = (ctx.context._vars as Record<string, unknown>) ?? {}
    const repo = str(c.repo) ?? str(c.repoUrl) ?? str(vars.repoUrl)
    const branch = str(c.branch) ?? str(c.branchName) ?? str(vars.branch) ?? 'main'
    if (!repo) return { kind: 'FAILED', reason: 'git node has no repo/repoUrl' }
    try {
      const res = await ctx.adapters.git.push({ repo, branch, message: str(c.message) })
      if (!res.ok) return { kind: 'FAILED', reason: 'git push failed' }
      return { kind: 'COMPLETED', output: { ref: res.ref, branch } }
    } catch (err) {
      if (err instanceof OfflineError) return block(ctx, 'git')
      throw err
    }
  },
}
