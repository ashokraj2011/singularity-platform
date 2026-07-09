import { describe, expect, it } from 'vitest'

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.JWT_SECRET ??= 'test-jwt-secret-with-enough-length-for-local-tests'

describe('work item trigger attachment mapping', () => {
  const payload = {
    event: {
      workItemId: 'wi-123',
      workCode: 'WRK-ABC',
      correlation: 'external-42',
    },
  }

  it('resolves dotted and JSONPath-style payload paths', () => {
    return import('../src/modules/work-items/work-item-trigger-attach').then(({ triggerStringAt }) => {
      expect(triggerStringAt(payload, 'event.workItemId')).toBe('wi-123')
      expect(triggerStringAt(payload, '$.event.workCode')).toBe('WRK-ABC')
    })
  })

  it('prefers mapped correlation keys before static trigger dedupe keys', async () => {
    const { resolveTriggerCorrelationKey } = await import('../src/modules/work-items/work-item-trigger-attach')
    expect(resolveTriggerCorrelationKey({
      payload,
      payloadMapping: { correlationKeyPath: '$.event.correlation' },
      dedupeKey: 'static-fallback',
    })).toBe('external-42')
  })

  it('uses static dedupe key when no payload correlation path is configured', async () => {
    const { resolveTriggerCorrelationKey } = await import('../src/modules/work-items/work-item-trigger-attach')
    expect(resolveTriggerCorrelationKey({
      payload,
      payloadMapping: {},
      dedupeKey: 'static-fallback',
    })).toBe('static-fallback')
  })

  it('normalizes document links and inline documents from mapped event payload paths', async () => {
    const { triggerDocumentsFromPayload } = await import('../src/modules/work-items/work-item-trigger-attach')
    const docs = triggerDocumentsFromPayload({
      payload: {
        event: {
          docs: [
            'https://docs.example/design.md',
            { title: 'Acceptance criteria', content: '# AC\n- Must validate the submitted document.' },
          ],
        },
      },
      payloadMapping: { documentsPath: '$.event.docs' },
    })

    expect(docs).toHaveLength(2)
    expect(docs[0]).toMatchObject({ url: 'https://docs.example/design.md', mediaType: 'text/uri-list' })
    expect(docs[1]).toMatchObject({ label: 'Acceptance criteria', content: '# AC\n- Must validate the submitted document.' })
  })
})
