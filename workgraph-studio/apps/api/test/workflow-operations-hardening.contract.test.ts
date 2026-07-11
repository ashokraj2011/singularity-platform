import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const operations = readFileSync(resolve(root, 'src/modules/workflow-operations/workflow-operations.router.ts'), 'utf8')
const intake = readFileSync(resolve(root, 'src/modules/events/event-intake.router.ts'), 'utf8')
const incoming = readFileSync(resolve(root, 'src/modules/audit/incoming-events.router.ts'), 'utf8')
const fanout = readFileSync(resolve(root, 'src/modules/work-items/work-item-event-fanout.ts'), 'utf8')
const subscriptions = readFileSync(resolve(root, 'src/modules/audit/event-subscriptions.router.ts'), 'utf8')
const dispatcher = readFileSync(resolve(root, 'src/lib/eventbus/dispatcher.ts'), 'utf8')

describe('workflow operations hardening contract', () => {
  it('assigns and propagates a platform trace for every canonical inbound event', () => {
    expect(intake).toMatch(/x-singularity-trace-id[\s\S]*?traceIdFromParts\(\['event'/)
    expect(intake).toMatch(/fanOutToWorkItemTriggersDetailed\([\s\S]*?traceId,/)
    expect(fanout).toMatch(/trace_id: args\.traceId \?\? null/)
  })

  it('guards active replay duplication and gives each replay a new trace', () => {
    expect(operations).toMatch(/replayCandidate[\s\S]*?replayStatus[\s\S]*?pass force=true/)
    expect(operations).toMatch(/traceIdFromParts\(\['event-replay'/)
  })

  it('requires tenant context in strict mode and admin ownership for mutations', () => {
    expect(operations).toMatch(/tenantIsolationStrict\(\)[\s\S]*?requireTenantFromRequest/)
    expect(operations).toMatch(/requireOperationsOperator[\s\S]*?isAdminUser/)
    expect(operations).toMatch(/outbox: \{ tenantId \}/)
    expect(subscriptions).toMatch(/requireAdmin[\s\S]*?isAdminUser/)
    expect(incoming).toMatch(/MISSING_EVENT_TENANT[\s\S]*?runWithTenantDbContext\(tenantId/)
  })

  it('rotates claim tokens on requeue without returning them in runner summaries', () => {
    expect(operations).toMatch(/post\('\/runners\/:id\/requeue'/)
    expect(operations).toMatch(/claimToken: randomUUID\(\)/)
    const runnerSummary = operations.slice(operations.indexOf("workflowOperationsRouter.get('/runners'"))
    expect(runnerSummary).not.toMatch(/claimToken: item\.claimToken/)
  })

  it('never returns event subscription secrets through list/get/write responses', () => {
    expect(subscriptions).toMatch(/sealSubscriptionSecret\(body\.secret\)/)
    expect(subscriptions).toMatch(/subs\.map\(publicSubscription\)/)
    expect(subscriptions).toMatch(/json\(publicSubscription\(sub\)\)/)
  })

  it('automatically seals legacy plaintext subscription secrets before dispatch starts', () => {
    expect(dispatcher).toMatch(/migrateLegacySubscriptionSecrets/)
    expect(dispatcher).toMatch(/secret NOT LIKE 'enc:v1:%'/)
    expect(dispatcher).toMatch(/sealSubscriptionSecret\(row\.secret\)/)
    expect(dispatcher).toMatch(/startEventDispatcher[\s\S]*?migrateLegacySubscriptionSecrets\(\)/)
  })
})
