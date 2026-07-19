import assert from 'node:assert/strict'
import { validateNodeConfig } from './resolver'

const req = { headers: {} } as never

async function expectFailure(nodeType: string, config: Record<string, unknown>, field: string, reasonIncludes: string) {
  const result = await validateNodeConfig(nodeType, config, req)
  assert.equal(result.ok, false, `${nodeType} should fail validation`)
  const match = result.failures.find(item => item.field === field && item.reason.includes(reasonIncludes))
  assert.ok(match, `${nodeType} should report ${field}: ${reasonIncludes}`)
}

async function expectOk(nodeType: string, config: Record<string, unknown>) {
  const result = await validateNodeConfig(nodeType, config, req)
  assert.equal(result.ok, true, `${nodeType} should pass validation: ${JSON.stringify(result.failures)}`)
}

async function main() {
  await expectFailure('CALL_WORKFLOW', {}, 'templateId', 'requires a target workflow template id')
  await expectOk('CALL_WORKFLOW', { standard: { templateId: '{{vars.childWorkflowTemplateId}}' } })

  await expectFailure('SIGNAL_WAIT', {}, 'signalName', 'requires a signalName')
  await expectOk('SIGNAL_WAIT', { standard: { signalName: '{{vars.signalName}}' } })

  await expectFailure('TIMER', {}, 'duration', 'empty timers fire immediately')
  await expectOk('TIMER', { duration: '5m' })

  await expectFailure('SET_CONTEXT', { assignments: [{ path: 'bad path', value: 'x' }] }, 'assignments.0.path', 'dotted identifier')
  await expectOk('SET_CONTEXT', { assignments: [{ path: 'globals.releaseReady', value: 'true' }] })

  await expectFailure('DATA_SINK', { sinkConfig: { kind: 'S3' } }, 'sinkConfig.kind', 'not implemented')
  await expectOk('DATA_SINK', { sinkConfig: { kind: 'ARTIFACT', artifactType: 'evidence' } })

  await expectFailure('EVENT_EMIT', { transport: 'SQS' }, 'queueUrl', 'requires queueUrl')
  await expectOk('EVENT_EMIT', { transport: 'EVENTBUS' })

  await expectFailure('EVENT_GATEWAY', {}, 'nodeType', 'not implemented at runtime')
}

void main().then(() => {
  console.log('node config validation contract tests passed')
})
