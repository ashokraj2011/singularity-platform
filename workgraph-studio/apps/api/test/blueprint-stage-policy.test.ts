/**
 * Server-side workbench stage-policy enforcement (security review #1/#2).
 *
 * The workbench worktree / api-call / run-test / verification routes used to
 * enforce only session ownership, so a user with session access could browse
 * repo code or run tools during STORY_ONLY / READ_ONLY / review stages by
 * calling the endpoints directly (the UI's canEdit/canRunTools gates are
 * client-side only). The routes now call stageActionRefusalReason() — the pure
 * decision mirrored from the UI's derivation. This pins that decision so server
 * enforcement and client affordances can't drift.
 */
import { describe, expect, it } from 'vitest'

import { stageActionRefusalReason } from '../src/modules/blueprint/blueprint.router'

const stage = (over: Partial<{ key: string; contextPolicy: string; toolPolicy: string; repoAccess: boolean }>) => ({
  key: 's',
  contextPolicy: 'CODE_EDIT' as const,
  toolPolicy: 'MUTATION' as const,
  repoAccess: true,
  ...over,
}) as Parameters<typeof stageActionRefusalReason>[0]

describe('stageActionRefusalReason — repoRead (code browsing)', () => {
  it('allows a normal repo stage', () => {
    expect(stageActionRefusalReason(stage({ contextPolicy: 'REPO_READ_ONLY', toolPolicy: 'READ_ONLY' }), 'repoRead')).toBeNull()
  })
  it('refuses STORY_ONLY (story intake cannot browse repo code)', () => {
    const r = stageActionRefusalReason(stage({ key: 'intake', contextPolicy: 'STORY_ONLY', toolPolicy: 'NONE', repoAccess: false }), 'repoRead')
    expect(r).toMatch(/does not have repo access/)
  })
  it('refuses when repoAccess is explicitly false', () => {
    expect(stageActionRefusalReason(stage({ repoAccess: false }), 'repoRead')).not.toBeNull()
  })
  it('refuses when toolPolicy is NONE', () => {
    expect(stageActionRefusalReason(stage({ toolPolicy: 'NONE' }), 'repoRead')).not.toBeNull()
  })
})

describe('stageActionRefusalReason — mutation (file edit)', () => {
  it('allows MUTATION stages', () => {
    expect(stageActionRefusalReason(stage({ toolPolicy: 'MUTATION' }), 'mutation')).toBeNull()
  })
  it('refuses VERIFICATION stages (qa can run tests but not edit)', () => {
    expect(stageActionRefusalReason(stage({ contextPolicy: 'VERIFY_ONLY', toolPolicy: 'VERIFICATION' }), 'mutation')).toMatch(/not a mutation stage/)
  })
  it('refuses READ_ONLY and review stages', () => {
    expect(stageActionRefusalReason(stage({ toolPolicy: 'READ_ONLY' }), 'mutation')).not.toBeNull()
    expect(stageActionRefusalReason(stage({ contextPolicy: 'EVIDENCE_REVIEW', toolPolicy: 'READ_ONLY' }), 'mutation')).not.toBeNull()
  })
})

describe('stageActionRefusalReason — toolRun (tests / api-call / verification receipt)', () => {
  it('allows MUTATION and VERIFICATION stages', () => {
    expect(stageActionRefusalReason(stage({ toolPolicy: 'MUTATION' }), 'toolRun')).toBeNull()
    expect(stageActionRefusalReason(stage({ toolPolicy: 'VERIFICATION' }), 'toolRun')).toBeNull()
  })
  it('refuses READ_ONLY / NONE / review stages (cannot fabricate a passing receipt)', () => {
    expect(stageActionRefusalReason(stage({ toolPolicy: 'READ_ONLY' }), 'toolRun')).toMatch(/does not permit tool execution/)
    expect(stageActionRefusalReason(stage({ toolPolicy: 'NONE' }), 'toolRun')).not.toBeNull()
    expect(stageActionRefusalReason(stage({ contextPolicy: 'EVIDENCE_REVIEW', toolPolicy: 'READ_ONLY' }), 'toolRun')).not.toBeNull()
  })
})
