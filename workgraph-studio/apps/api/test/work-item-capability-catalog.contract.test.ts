import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const lookup = fs.readFileSync(path.join(process.cwd(), 'src/modules/lookup/lookup.router.ts'), 'utf8')
const resolver = fs.readFileSync(path.join(process.cwd(), 'src/modules/lookup/resolver.ts'), 'utf8')
const workItems = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-items.router.ts'), 'utf8')

describe('Agent and Tools capability catalog contract', () => {
  it('uses Agent Runtime as the selectable capability catalog and IAM only as an overlay', () => {
    expect(lookup).toMatch(/const runtimeCaps = await listRuntimeCapabilities\(authHeader\(req\)\)/)
    expect(lookup).toMatch(/authorizationOverlay: iamRow \? 'linked' : 'unlinked'/)
    expect(lookup).toMatch(/source: iamRow \? 'agent-runtime\+iam' : 'agent-runtime'/)
    expect(lookup).not.toMatch(/if \(!iamRow\) continue/)
  })

  it('resolves workflow capability references against Agent Runtime', () => {
    expect(resolver).toMatch(/case 'capability':[\s\S]*?getRuntimeCapability\(id, authHeader\(req\)\)/)
    expect(resolver).toMatch(/source: 'agent-runtime'/)
  })

  it('rejects WorkItem targets that are absent or inactive in Agent Runtime', () => {
    expect(workItems).toMatch(/async function assertAgentRuntimeTargets\(/)
    expect(workItems).toMatch(/await assertAgentRuntimeTargets\(body\.targets, req\.headers\.authorization\)/)
    expect(workItems).toMatch(/WorkItems require an ACTIVE Agent and Tools capability/)
  })
})
