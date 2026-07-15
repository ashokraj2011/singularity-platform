// ─────────────────────────────────────────────────────────────────────────────
// Executor registry — maps node types to executors. Unregistered node types are
// treated as service-bound and BLOCK when offline (safe default), so an image
// with a node type this VM build doesn't know about parks rather than silently
// skipping work.
// ─────────────────────────────────────────────────────────────────────────────

import type { NodeExecutor } from '../types.js'
import { setContextExecutor, structuralExecutor } from './deterministic.js'
import { humanTaskExecutor, governanceGateExecutor } from './serviceBound.js'
import { llmTaskExecutor, toolRequestExecutor, gitExecutor } from './tasks.js'
import { timerExecutor } from './timer.js'
import { discoveryExecutor } from './discovery.js'

export class ExecutorRegistry {
  private map = new Map<string, NodeExecutor>()

  register(executor: NodeExecutor): this {
    for (const t of executor.handles) this.map.set(t, executor)
    return this
  }

  get(nodeType: string): NodeExecutor | undefined {
    return this.map.get(nodeType)
  }

  has(nodeType: string): boolean {
    return this.map.has(nodeType)
  }
}

export function defaultRegistry(): ExecutorRegistry {
  return new ExecutorRegistry()
    .register(setContextExecutor)
    .register(structuralExecutor)
    .register(humanTaskExecutor)
    .register(governanceGateExecutor)
    .register(llmTaskExecutor)
    .register(toolRequestExecutor)
    .register(gitExecutor)
    .register(timerExecutor)
    .register(discoveryExecutor)
}
