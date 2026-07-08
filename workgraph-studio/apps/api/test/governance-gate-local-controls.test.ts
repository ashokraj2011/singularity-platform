import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '@prisma/client'
import {
  localControlsFromConfig,
  localOverlayFromControls,
  normalizeGovernanceGateMode,
} from '../src/modules/workflow/runtime/executors/GovernanceGateExecutor'
import { evaluateGovernanceBlock } from '../src/modules/workflow/runtime/executors/governance/evaluateBlock'

function node(config: Record<string, unknown>): WorkflowNode {
  return { id: 'gate-1', nodeType: 'GOVERNANCE_GATE', label: 'Governance Gate', config } as unknown as WorkflowNode
}

describe('Governance Gate local controls', () => {
  it('normalizes hard, soft, automatic, and manual mode labels', () => {
    expect(normalizeGovernanceGateMode('hard')).toBe('HARD_BLOCK')
    expect(normalizeGovernanceGateMode('soft')).toBe('SOFT_WARN')
    expect(normalizeGovernanceGateMode('auto')).toBe('AUTOMATIC')
    expect(normalizeGovernanceGateMode('human_approval_required')).toBe('MANUAL_REVIEW')
  })

  it('expands ergonomic artifact, formal, diff, standard, and predicate config into controls', () => {
    const controls = localControlsFromConfig(node({
      standard: {
        requiredArtifacts: 'design,test-report',
        runFormalVerifier: 'true',
        diffValidation: '{"requireTests":true,"forbiddenPaths":["infra/*"]}',
        standardName: 'Design Standard',
        standardText: 'Must include rollout and tests.',
        documentKey: 'designDocument',
        predicate: '{"path":"metrics.coverage","op":"gte","value":80}',
      },
    }))

    expect(controls.map(c => c.controlKey)).toEqual([
      'ARTIFACT:design',
      'ARTIFACT:test-report',
      'FORMAL_VERIFICATION',
      'DIFF_VS_DESIGN',
      'STANDARD:Design Standard',
      'CUSTOM_PREDICATE',
    ])

    const { overlay, bindings } = localOverlayFromControls(controls)
    expect(overlay?.requiredEvidence?.map(ev => ev.evidenceKey)).toContain('FORMAL_VERIFICATION')
    expect(bindings['ARTIFACT:design']).toMatchObject({ type: 'artifact', artifactName: 'design' })
    expect(bindings.FORMAL_VERIFICATION).toMatchObject({ type: 'formal' })
    expect(bindings.DIFF_VS_DESIGN).toMatchObject({ type: 'diff', diffValidation: { requireTests: true } })
    expect(bindings['STANDARD:Design Standard']).toMatchObject({ type: 'standard', standardName: 'Design Standard', documentKey: 'designDocument' })
    expect(bindings.CUSTOM_PREDICATE).toMatchObject({ type: 'predicate', predicate: { path: 'metrics.coverage', op: 'gte', value: 80 } })
  })

  it('uses configured local-control reasons when a required check is not satisfied', () => {
    const controls = localControlsFromConfig(node({
      standard: {
        gateControls: '[{"controlKey":"DESIGN_REVIEW","mode":"BLOCKING","reason":"design review evidence is missing","binding":{"type":"receipt","evidenceKey":"DESIGN_REVIEW"}}]',
      },
    }))
    const { overlay } = localOverlayFromControls(controls)

    const blocked = evaluateGovernanceBlock(overlay, new Set(), new Set())

    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({
      controlKey: 'DESIGN_REVIEW',
      reason: 'design review evidence is missing',
      mode: 'BLOCKING',
    })
  })
})
