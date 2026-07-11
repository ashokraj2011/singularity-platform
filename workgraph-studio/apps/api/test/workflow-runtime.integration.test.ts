/**
 * Workflow runtime — REAL Postgres integration tests.
 *
 * This is the layer the mocked unit tests lack. It runs the runtime's RAW SQL and a
 * real engine advance against an actual Postgres, which is the ONLY way to catch
 * type-mismatch bugs the type-checker + esbuild can't — e.g. the `text = uuid`
 * (Postgres 42883) regression where a `::uuid` cast on the TEXT `workflow_nodes.id`
 * column broke PARALLEL_JOIN advancement and the timer/stuck sweeps, yet still
 * compiled and shipped to a live stack.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. CI provisions a throwaway Postgres,
 * applies the schema (prisma db push), and sets TEST_DATABASE_URL === DATABASE_URL
 * so the app's prisma client (used by startInstance) points at it. Locally:
 *   TEST_DATABASE_URL=postgresql://... DATABASE_URL=postgresql://... npx vitest run \
 *     test/workflow-runtime.integration.test.ts
 * See docs/integration-tests.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { startInstance } from '../src/modules/workflow/runtime/WorkflowRuntime'

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL)

describe.runIf(HAS_DB)('workflow runtime — real Postgres', () => {
  const created: string[] = []

  async function seedInstance(name: string): Promise<string> {
    const id = randomUUID()
    await prisma.workflowInstance.create({ data: { id, name, status: 'DRAFT', tenantId: 'default' } })
    created.push(id)
    return id
  }

  afterAll(async () => {
    // Best-effort cleanup (the CI DB is throwaway anyway).
    for (const id of created) {
      await prisma.workflowNode.deleteMany({ where: { instanceId: id } }).catch(() => {})
      await prisma.workflowEdge.deleteMany({ where: { instanceId: id } }).catch(() => {})
      await prisma.workflowMutation.deleteMany({ where: { instanceId: id } }).catch(() => {})
      await prisma.workflowInstance.deleteMany({ where: { id } }).catch(() => {})
    }
    await prisma.$disconnect().catch(() => {})
  })

  // ── Raw-SQL regression tests — run the EXACT patterns from the runtime against a
  // real DB. `workflow_nodes.id` is TEXT; a `::uuid` cast reintroduces `text = uuid`.
  describe('runtime raw SQL executes against the TEXT id column', () => {
    let instanceId = ''
    let nodeId = ''
    beforeAll(async () => {
      instanceId = await seedInstance('it-raw-sql')
      nodeId = randomUUID()
      await prisma.workflowNode.create({
        data: { id: nodeId, instanceId, label: 'join', nodeType: 'PARALLEL_JOIN', status: 'ACTIVE',
          config: { completed_joins: 0, _attempts: 0 } as object },
      })
    })

    it('GraphTraverser PARALLEL_JOIN increment (no text = uuid)', async () => {
      const affected = await prisma.$executeRaw`
        UPDATE workflow_nodes
        SET config = jsonb_set(config, '{completed_joins}', (COALESCE((config->>'completed_joins')::int, 0) + 1)::text::jsonb)
        WHERE id = ${nodeId}
      `
      expect(affected).toBe(1)
      const row = await prisma.workflowNode.findUnique({ where: { id: nodeId } })
      expect(Number((row?.config as Record<string, unknown>)?.completed_joins)).toBe(1)
    })

    it('StuckRunSweep single-attempt claim', async () => {
      const affected = await prisma.$executeRaw`
        UPDATE "workflow_nodes"
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{_stuckSweptAttempt}', COALESCE(config->'_attempts', '0'::jsonb))
        WHERE id = ${nodeId}
          AND status = 'ACTIVE'
          AND COALESCE(config->>'_stuckSweptAttempt', '') IS DISTINCT FROM COALESCE(config->>'_attempts', '0')
      `
      expect(affected).toBe(1)
    })

    it('TimerSweep single-fire claim', async () => {
      await prisma.workflowNode.update({ where: { id: nodeId }, data: { config: { _fireAt: new Date(0).toISOString() } as object } })
      const affected = await prisma.$executeRaw`
        UPDATE "workflow_nodes" SET config = config - '_fireAt'
        WHERE id = ${nodeId} AND status = 'ACTIVE' AND config ? '_fireAt'
      `
      expect(affected).toBe(1)
    })
  })

  // ── End-to-end engine run — proves the runtime boots + advances + completes against
  // a real DB (structural START→END; no external services needed).
  it('startInstance runs a START→END graph to COMPLETED', async () => {
    const instanceId = await seedInstance('it-run-start-end')
    const startId = randomUUID()
    const endId = randomUUID()
    await prisma.workflowNode.createMany({ data: [
      { id: startId, instanceId, label: 'start', nodeType: 'START', status: 'PENDING', config: {} as object },
      { id: endId, instanceId, label: 'end', nodeType: 'END', status: 'PENDING', config: {} as object },
    ] })
    await prisma.workflowEdge.create({ data: { id: randomUUID(), instanceId, sourceNodeId: startId, targetNodeId: endId } })

    await startInstance(instanceId, undefined, 'default')

    const instance = await prisma.workflowInstance.findUnique({ where: { id: instanceId } })
    expect(instance?.status).toBe('COMPLETED')
  })

  // ── The real prize: a full PARALLEL_JOIN run exercises GraphTraverser's join
  // increment in situ. Needs branch nodes that complete in-process without external
  // services — finalize the node types once running against a live test DB.
  it.todo('startInstance runs a START→[A,B]→PARALLEL_JOIN→END graph to COMPLETED')
})
