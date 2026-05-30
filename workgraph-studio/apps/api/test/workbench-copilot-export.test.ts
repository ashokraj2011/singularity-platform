/**
 * M97 — Unit tests for the workbench → GitHub Copilot playbook exporter.
 *
 * The builder is a PURE function (it takes an already-loaded definition view
 * plus already-resolved prompts and returns strings), so these tests need no
 * Postgres, no prompt-composer, no network. They assert the two output shapes
 * the operator gets when they click "Download for Copilot":
 *
 *   • `.agent.md` — YAML frontmatter + Markdown body the Copilot CLI runs.
 *   • `.yaml`     — a pure structured playbook.
 *
 * No YAML parser is available as a dependency in this package, so the YAML
 * shape is checked with structural string assertions against the (small,
 * deterministic) emitter.
 */
import { describe, it, expect } from 'vitest'
import type {
  WorkbenchDefinitionView,
  WorkbenchStageView,
} from '../src/modules/workflow/workbench-definitions.service'
import {
  buildCopilotAgentMd,
  buildCopilotYaml,
  exportFilename,
  slugify,
  toolPolicyGuidance,
  type ExportStagePrompt,
} from '../src/modules/workflow/workbench-copilot-export'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function stage(partial: Partial<WorkbenchStageView> & Pick<WorkbenchStageView, 'id' | 'stageKey' | 'ordinal'>): WorkbenchStageView {
  return {
    id: partial.id,
    stageKey: partial.stageKey,
    label: partial.label ?? partial.stageKey,
    agentRole: partial.agentRole ?? 'AGENT',
    agentTemplateId: partial.agentTemplateId ?? null,
    promptProfileKey: partial.promptProfileKey ?? null,
    ordinal: partial.ordinal,
    positionX: null,
    positionY: null,
    required: partial.required ?? true,
    terminal: partial.terminal ?? false,
    approvalRequired: partial.approvalRequired ?? false,
    repoAccess: partial.repoAccess ?? false,
    toolPolicy: partial.toolPolicy ?? 'NONE',
    contextPolicy: partial.contextPolicy ?? 'STORY_ONLY',
    expectedArtifacts: partial.expectedArtifacts ?? [],
    questions: partial.questions ?? [],
  }
}

function fixtureDef(): WorkbenchDefinitionView {
  const intake = stage({
    id: 's-intake', stageKey: 'INTAKE', ordinal: 0, label: 'Story intake',
    agentRole: 'PRODUCT_OWNER', toolPolicy: 'NONE', contextPolicy: 'STORY_ONLY',
    expectedArtifacts: [
      { id: 'a1', kind: 'story_brief', title: 'Story brief', description: 'Clarified requirements', format: 'MARKDOWN', required: true, ordinal: 0, editable: true },
    ],
  })
  const dev = stage({
    id: 's-dev', stageKey: 'DEVELOP', ordinal: 1, label: 'Implement the change',
    agentRole: 'DEVELOPER', toolPolicy: 'MUTATION', contextPolicy: 'CODE_EDIT',
    approvalRequired: true, repoAccess: true,
    expectedArtifacts: [
      { id: 'a2', kind: 'implementation_pack', title: 'Implementation pack', description: null, format: 'CODE', required: true, ordinal: 0, editable: false },
    ],
  })
  const qa = stage({
    id: 's-qa', stageKey: 'QA', ordinal: 2, label: 'Verify',
    agentRole: 'QA', toolPolicy: 'VERIFICATION', contextPolicy: 'VERIFY_ONLY',
    terminal: true, repoAccess: true,
    expectedArtifacts: [
      { id: 'a3', kind: 'test_report', title: 'Test report', description: null, format: 'JSON', required: true, ordinal: 0, editable: false },
    ],
  })
  return {
    id: 'def-1',
    workflowNodeId: 'node-1',
    name: 'RuleEngine Coding Loop',
    version: 3,
    goal: 'Implement and verify changes to the RuleEngine service.',
    sourceType: 'github',
    sourceUri: 'https://github.com/acme/rule-engine',
    sourceRef: 'main',
    capabilityId: 'cap-1',
    architectAgentTemplateId: null,
    developerAgentTemplateId: null,
    qaAgentTemplateId: null,
    maxLoopsPerStage: 6,
    maxTotalSendBacks: 3,
    gateMode: 'manual',
    finalPackKey: null,
    stages: [intake, dev, qa],
    edges: [
      { id: 'e1', fromStageId: 's-intake', toStageId: 's-dev', kind: 'FORWARD', label: null },
      { id: 'e2', fromStageId: 's-dev', toStageId: 's-qa', kind: 'FORWARD', label: null },
      { id: 'e3', fromStageId: 's-qa', toStageId: 's-dev', kind: 'SEND_BACK', label: 'tests failed' },
    ],
    consumes: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  }
}

function fixturePrompts(): Record<string, ExportStagePrompt> {
  return {
    INTAKE: {
      task: 'Clarify the story.\n\n- Identify acceptance criteria\n- List open questions',
      systemPromptAppend: 'You are a meticulous product owner.',
      extraContext: 'World-model: this repo uses Maven + JUnit.',
      resolved: true,
    },
    DEVELOP: {
      task: 'Implement the change with minimal, targeted edits.',
      systemPromptAppend: '',
      extraContext: '',
      resolved: true,
    },
    // QA deliberately unresolved → exercises the fallback path.
    QA: {
      task: '',
      systemPromptAppend: '',
      extraContext: '',
      resolved: false,
      note: 'prompt-composer 404',
    },
  }
}

const GEN_AT = '2026-05-29T12:00:00.000Z'

// ─── slugify / filename / policy helpers ─────────────────────────────────────

describe('M97 — helpers', () => {
  it('slugify lowercases and dash-joins', () => {
    expect(slugify('RuleEngine Coding Loop')).toBe('ruleengine-coding-loop')
    expect(slugify('  weird__Name!! ')).toBe('weird-name')
    expect(slugify('')).toBe('workbench-loop')
  })

  it('exportFilename picks extension by format', () => {
    const def = fixtureDef()
    expect(exportFilename(def, 'agent-md')).toBe('ruleengine-coding-loop.agent.md')
    expect(exportFilename(def, 'yaml')).toBe('ruleengine-coding-loop.workflow.yaml')
  })

  it('toolPolicyGuidance maps each policy', () => {
    expect(toolPolicyGuidance('MUTATION').tools).toContain('apply_patch')
    expect(toolPolicyGuidance('READ_ONLY').tools).toContain('read_file')
    expect(toolPolicyGuidance('VERIFICATION').tools).toContain('run_test')
    expect(toolPolicyGuidance('NONE').tools).toEqual([])
  })
})

// ─── .agent.md ───────────────────────────────────────────────────────────────

describe('M97 — buildCopilotAgentMd', () => {
  const md = buildCopilotAgentMd({ def: fixtureDef(), prompts: fixturePrompts(), generatedAt: GEN_AT })

  it('opens with YAML frontmatter carrying name + description', () => {
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('name: "ruleengine-coding-loop"')
    expect(md).toContain('description: "Implement and verify changes to the RuleEngine service."')
    // frontmatter is closed before the body
    expect(md.indexOf('---', 4)).toBeGreaterThan(0)
  })

  it('includes operating constraints (agent learnings)', () => {
    expect(md).toContain('## Agent learnings & operating constraints')
    expect(md).toContain('**Max loops per stage:** 6')
    expect(md).toContain('**Max total send-backs:** 3')
    expect(md).toContain('**Gate mode:** manual')
    expect(md).toContain('github `https://github.com/acme/rule-engine` @ main')
    // per-stage guidance distilled from resolved prompts
    expect(md).toContain('You are a meticulous product owner.')
    expect(md).toContain('World-model: this repo uses Maven + JUnit.')
  })

  it('renders every stage in ordinal order with policy + transitions', () => {
    expect(md).toContain('### 1. INTAKE — Story intake')
    expect(md).toContain('### 2. DEVELOP — Implement the change')
    expect(md).toContain('### 3. QA — Verify')
    expect(md.indexOf('### 1. INTAKE')).toBeLessThan(md.indexOf('### 2. DEVELOP'))
    expect(md.indexOf('### 2. DEVELOP')).toBeLessThan(md.indexOf('### 3. QA'))
    // tool policy guidance
    expect(md).toContain('**Tool policy:** `MUTATION`')
    expect(md).toContain('**Approval required before advancing:** yes')
    // transitions resolved by stageKey, not id
    expect(md).toContain('**On success → advance to:** DEVELOP')
    expect(md).toContain('**On rejection → send back to:** DEVELOP')
    expect(md).toContain('**Terminal stage:** yes')
  })

  it('embeds the resolved prompt text', () => {
    expect(md).toContain('Clarify the story.')
    expect(md).toContain('- Identify acceptance criteria')
    expect(md).toContain('Implement the change with minimal, targeted edits.')
  })

  it('falls back with a visible note for an unresolved prompt', () => {
    expect(md).toContain('No bound prompt could be resolved for this stage: prompt-composer 404')
  })

  it('lists documents per stage and in a summary table', () => {
    expect(md).toContain('`story_brief` — Story brief (MARKDOWN, required)')
    expect(md).toContain('## Document creation summary')
    expect(md).toContain('| INTAKE | `story_brief` | Story brief | MARKDOWN | yes |')
    expect(md).toContain('| QA | `test_report` | Test report | JSON | yes |')
  })
})

// ─── pure YAML ───────────────────────────────────────────────────────────────

describe('M97 — buildCopilotYaml', () => {
  const yaml = buildCopilotYaml({ def: fixtureDef(), prompts: fixturePrompts(), generatedAt: GEN_AT })

  it('carries the document header + provenance', () => {
    expect(yaml).toContain('apiVersion: singularity.workbench/v1')
    expect(yaml).toContain('kind: CopilotWorkflow')
    expect(yaml).toContain('name: "ruleengine-coding-loop"')
    expect(yaml).toContain('  workbenchDefinitionId: "def-1"')
    expect(yaml).toContain('  workflowNodeId: "node-1"')
    expect(yaml).toContain('  exportedAt: "2026-05-29T12:00:00.000Z"')
  })

  it('emits agentLearnings with per-stage guidance as block scalars', () => {
    expect(yaml).toContain('agentLearnings:')
    expect(yaml).toContain('  maxLoopsPerStage: 6')
    expect(yaml).toContain('  perStageGuidance:')
    expect(yaml).toContain('    - stageKey: "INTAKE"')
    expect(yaml).toContain('      systemPrompt: |-')
    // block-scalar content is indented to 8 spaces under the 6-space key
    expect(yaml).toContain('        You are a meticulous product owner.')
  })

  it('emits one workflow entry per stage with quoted keys', () => {
    expect(yaml).toContain('workflow:')
    expect(yaml).toContain('  - stageKey: "INTAKE"')
    expect(yaml).toContain('  - stageKey: "DEVELOP"')
    expect(yaml).toContain('  - stageKey: "QA"')
    expect(yaml).toContain('    toolPolicy: "MUTATION"')
    expect(yaml).toContain('    approvalRequired: true')
    expect(yaml).toContain('    terminal: true')
  })

  it('emits prompts as literal block scalars with 6-space content indent', () => {
    expect(yaml).toContain('    prompt: |-')
    expect(yaml).toContain('      Clarify the story.')
    expect(yaml).toContain('      - Identify acceptance criteria')
  })

  it('renders the unresolved stage with empty prompt + promptNote', () => {
    expect(yaml).toContain("    prompt: ''")
    expect(yaml).toContain('    promptNote: "prompt-composer 404"')
  })

  it('emits transitions resolved by stageKey', () => {
    expect(yaml).toContain('      forward: ["DEVELOP"]')
    expect(yaml).toContain('      sendBack: ["DEVELOP"]')
  })

  it('emits documents per stage', () => {
    expect(yaml).toContain('    documents:')
    expect(yaml).toContain('      - kind: "story_brief"')
    expect(yaml).toContain('        format: "MARKDOWN"')
    expect(yaml).toContain('        required: true')
  })

  it('ends with a trailing newline', () => {
    expect(yaml.endsWith('\n')).toBe(true)
  })
})
