import { describe, expect, it } from 'vitest'
import { resolveRuntimeTenantId, runtimeTenantRequired } from '../src/lib/runtime-tenant'

describe('runtime tenant resolution', () => {
  it('prefers explicit node tenant over runtime context', () => {
    expect(resolveRuntimeTenantId({
      nodeConfig: { tenantId: 'tenant-node' },
      instanceContext: { tenantId: 'tenant-context' },
    })).toBe('tenant-node')
  })

  it('reads tenant from standard config, vars, globals, and WorkItem input', () => {
    expect(resolveRuntimeTenantId({
      nodeConfig: { standard: { tenant_id: 'tenant-standard' } },
      instanceContext: {},
    })).toBe('tenant-standard')

    expect(resolveRuntimeTenantId({
      instanceContext: { _vars: { tenantId: 'tenant-vars' } },
    })).toBe('tenant-vars')

    expect(resolveRuntimeTenantId({
      instanceContext: { _globals: { tenant_id: 'tenant-globals' } },
    })).toBe('tenant-globals')

    expect(resolveRuntimeTenantId({
      instanceContext: {
        _workItem: {
          input: { tenantId: 'tenant-work-item-input' },
        },
      },
    })).toBe('tenant-work-item-input')
  })

  it('detects strict tenant mode', () => {
    expect(runtimeTenantRequired('strict')).toBe(true)
    expect(runtimeTenantRequired('STRICT')).toBe(true)
    expect(runtimeTenantRequired('off')).toBe(false)
    expect(runtimeTenantRequired(undefined)).toBe(false)
  })
})
