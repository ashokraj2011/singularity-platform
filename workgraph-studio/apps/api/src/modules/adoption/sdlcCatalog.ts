export type SdlcIntent =
  | 'build_feature'
  | 'fix_bug'
  | 'refactor_safely'
  | 'add_tests'
  | 'security_review'
  | 'release_evidence'

export type SdlcIntentDefinition = {
  id: SdlcIntent
  label: string
  description: string
  workflowTypeKeys: string[]
  requiredInputs: string[]
  sampleStory: string
  defaultAgents: string[]
  defaultModelAlias: string
  runtimePreference: 'user_runtime' | 'tenant_runtime' | 'mock_ok'
  governancePreset: 'standard' | 'strict' | 'evidence_first'
}

export const SDLC_INTENTS: SdlcIntentDefinition[] = [
  {
    id: 'build_feature',
    label: 'Build Feature',
    description: 'Turn a product story into design, implementation, verification, approvals, and evidence.',
    workflowTypeKeys: ['STORY_IMPL', 'SDLC', 'GENERAL'],
    requiredInputs: ['story', 'capabilityId', 'repositoryUrl'],
    sampleStory: 'As a user, I want saved checkout addresses so repeat purchases are faster and auditable.',
    defaultAgents: ['PRODUCT_OWNER', 'ARCHITECT', 'DEVELOPER', 'QA'],
    defaultModelAlias: 'balanced',
    runtimePreference: 'user_runtime',
    governancePreset: 'standard',
  },
  {
    id: 'fix_bug',
    label: 'Fix Bug',
    description: 'Reproduce, isolate, patch, test, and produce a regression-proof delivery receipt.',
    workflowTypeKeys: ['BUG_FIX', 'STORY_IMPL', 'SDLC', 'GENERAL'],
    requiredInputs: ['bugReport', 'capabilityId', 'repositoryUrl'],
    sampleStory: 'Users see a 500 error when exporting workflow evidence if an artifact has no MIME type.',
    defaultAgents: ['DEVELOPER', 'QA', 'ARCHITECT'],
    defaultModelAlias: 'fast',
    runtimePreference: 'user_runtime',
    governancePreset: 'standard',
  },
  {
    id: 'refactor_safely',
    label: 'Refactor Safely',
    description: 'Constrain a code change, preserve behavior, run checks, and emit before/after evidence.',
    workflowTypeKeys: ['REFACTOR', 'STORY_IMPL', 'SDLC', 'GENERAL'],
    requiredInputs: ['scope', 'capabilityId', 'repositoryUrl'],
    sampleStory: 'Refactor workflow run export code so YAML and runner generation share one safe stage model.',
    defaultAgents: ['ARCHITECT', 'DEVELOPER', 'QA'],
    defaultModelAlias: 'balanced',
    runtimePreference: 'user_runtime',
    governancePreset: 'strict',
  },
  {
    id: 'add_tests',
    label: 'Add Tests',
    description: 'Identify missing coverage, add focused tests, run them, and attach evidence.',
    workflowTypeKeys: ['TESTING', 'QA', 'STORY_IMPL', 'SDLC', 'GENERAL'],
    requiredInputs: ['testGoal', 'capabilityId', 'repositoryUrl'],
    sampleStory: 'Add tests for runtime bridge routing: user runtime wins, tenant fallback is second, HTTP fallback is gated.',
    defaultAgents: ['QA', 'DEVELOPER'],
    defaultModelAlias: 'fast',
    runtimePreference: 'user_runtime',
    governancePreset: 'standard',
  },
  {
    id: 'security_review',
    label: 'Security Review',
    description: 'Threat-model the change, inspect risky paths, require fixes, and preserve audit evidence.',
    workflowTypeKeys: ['SECURITY_REVIEW', 'COMPLIANCE', 'SDLC', 'GENERAL'],
    requiredInputs: ['securityQuestion', 'capabilityId', 'repositoryUrl'],
    sampleStory: 'Review service-token proxying and runtime JWT handling for tenant boundary bypass risks.',
    defaultAgents: ['SECURITY', 'ARCHITECT', 'DEVELOPER'],
    defaultModelAlias: 'reasoning',
    runtimePreference: 'tenant_runtime',
    governancePreset: 'strict',
  },
  {
    id: 'release_evidence',
    label: 'Release Evidence',
    description: 'Collect test, approval, artifact, cost, and receipt evidence into a delivery pack.',
    workflowTypeKeys: ['RELEASE', 'COMPLIANCE', 'SDLC', 'GENERAL'],
    requiredInputs: ['releaseScope', 'capabilityId'],
    sampleStory: 'Prepare release evidence for the Runtime Bridge migration with run receipts, costs, tests, and approvals.',
    defaultAgents: ['GOVERNANCE', 'QA', 'PRODUCT_OWNER'],
    defaultModelAlias: 'balanced',
    runtimePreference: 'mock_ok',
    governancePreset: 'evidence_first',
  },
]

export function normalizeSdlcIntent(value: unknown): SdlcIntent {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return (SDLC_INTENTS.some(intent => intent.id === raw) ? raw : 'build_feature') as SdlcIntent
}

export function getSdlcIntent(value: unknown): SdlcIntentDefinition {
  const id = normalizeSdlcIntent(value)
  return SDLC_INTENTS.find(intent => intent.id === id) ?? SDLC_INTENTS[0]
}

