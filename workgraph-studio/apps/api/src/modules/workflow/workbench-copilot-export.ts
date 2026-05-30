/**
 * M97 — Export a workbench definition as a single, portable GitHub Copilot
 * playbook file.
 *
 * Two output shapes, both produced from the same in-memory model so they
 * never drift:
 *
 *   • `.agent.md`  — the format the GitHub Copilot CLI actually runs. YAML
 *                    frontmatter (name + description) followed by a Markdown
 *                    body. Drop it in `.github/agents/` and the CLI picks it
 *                    up as a custom agent. MCP/tools are supplied by the
 *                    operator's CLI environment — this file only *names* the
 *                    tool policy each stage should obey.
 *
 *   • `.yaml`      — a pure structured playbook for callers who feed the
 *                    workflow into their own harness rather than the CLI.
 *
 * Both carry the four things an operator asked for: agent learnings,
 * per-stage prompts, the stage workflow (with gates + transitions), and the
 * documents each stage must produce.
 *
 * This module is intentionally PURE: it takes the already-loaded definition
 * view plus the already-resolved per-stage prompts and returns strings. No
 * network, no DB — so it is trivially unit-testable. The router (M97.2) does
 * the I/O.
 *
 * The YAML is hand-emitted (literal block scalars for multi-line prompts,
 * JSON-quoted flow scalars for everything else) to avoid pulling a new
 * runtime dependency into workgraph-api for one feature.
 */
import type { WorkbenchDefinitionView, WorkbenchStageView } from './workbench-definitions.service'

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * A stage's prompt as resolved from prompt-composer. `resolved=false` means
 * the resolve call failed (composer down, no binding) — the builder still
 * emits the stage, with a visible note, rather than failing the whole export.
 */
export interface ExportStagePrompt {
  task: string
  systemPromptAppend: string
  extraContext: string
  resolved: boolean
  note?: string
}

export interface BuildCopilotExportInput {
  def: WorkbenchDefinitionView
  /** keyed by stageKey */
  prompts: Record<string, ExportStagePrompt>
  /** ISO timestamp; defaults to now. Injectable for deterministic tests. */
  generatedAt?: string
}

// ─── Policy → human guidance ───────────────────────────────────────────────

interface PolicyGuidance {
  summary: string
  /** Illustrative tool names — the real set comes from the CLI's MCP config. */
  tools: string[]
}

export function toolPolicyGuidance(toolPolicy: string): PolicyGuidance {
  switch (toolPolicy) {
    case 'READ_ONLY':
      return {
        summary: 'Read-only repository inspection. Do NOT edit files or run commands.',
        tools: ['repo_map', 'symbol_search', 'list_files', 'read_file', 'read_repo_instructions'],
      }
    case 'MUTATION':
      return {
        summary:
          'Edit code. Apply minimal, targeted patches and record every file you change before advancing.',
        tools: ['repo_map', 'symbol_search', 'list_files', 'read_file', 'apply_patch', 'write_file'],
      }
    case 'VERIFICATION':
      return {
        summary:
          'Run tests / verification commands and capture their output. Do NOT edit code in this stage.',
        tools: ['run_test', 'read_file', 'list_files'],
      }
    case 'NONE':
    default:
      return {
        summary:
          'No repository tools. Reason about the story / requirements and produce the written artifacts.',
        tools: [],
      }
  }
}

export function contextPolicyGuidance(contextPolicy: string): string {
  switch (contextPolicy) {
    case 'STORY_ONLY':
      return 'Story context only — no repository access.'
    case 'REPO_READ_ONLY':
      return 'Repository available, read-only.'
    case 'CODE_EDIT':
      return 'Repository is editable.'
    case 'VERIFY_ONLY':
      return 'Repository available for running verification.'
    case 'EVIDENCE_REVIEW':
      return 'Review prior evidence and artifacts (read-only).'
    case 'NONE':
    default:
      return 'No repository context.'
  }
}

// ─── Small helpers ─────────────────────────────────────────────────────────

export function slugify(input: string): string {
  const s = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'workbench-loop'
}

/** Map stageId → stageKey for rendering edge targets by their readable key. */
function stageKeyById(def: WorkbenchDefinitionView): Map<string, string> {
  return new Map(def.stages.map(s => [s.id, s.stageKey]))
}

interface StageTransitions {
  forward: string[]
  sendBack: string[]
}

function transitionsFor(def: WorkbenchDefinitionView, stage: WorkbenchStageView): StageTransitions {
  const byId = stageKeyById(def)
  const forward: string[] = []
  const sendBack: string[] = []
  for (const e of def.edges) {
    if (e.fromStageId !== stage.id) continue
    const target = byId.get(e.toStageId)
    if (!target) continue
    if (e.kind === 'SEND_BACK') sendBack.push(target)
    else forward.push(target)
  }
  return { forward, sendBack }
}

function firstLine(s: string, max = 200): string {
  const line = (s || '').replace(/\r\n/g, '\n').split('\n').find(l => l.trim().length) ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed
}

// ─── YAML emit helpers (hand-rolled, minimal) ────────────────────────────────

/** Safe single-line scalar via JSON double-quoting (valid YAML 1.2). */
function yScalar(s: string | null | undefined): string {
  return JSON.stringify(s ?? '')
}

/**
 * Literal block scalar (`|-`) for multi-line content. Every non-empty line is
 * indented to `contentIndent`; blank lines stay blank. Leading/trailing blank
 * lines are trimmed so the parser's indentation auto-detect is unambiguous.
 * Returns `""` (empty quoted scalar) for empty content.
 */
function yBlock(content: string, contentIndent: number): string {
  const normalized = (content ?? '').replace(/\r\n/g, '\n').replace(/\t/g, '  ')
  const lines = normalized.split('\n')
  // trim leading/trailing blank lines
  while (lines.length && lines[0]!.trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop()
  if (lines.length === 0) return "''"
  const pad = ' '.repeat(contentIndent)
  const body = lines.map(l => (l.trim().length ? pad + l : '')).join('\n')
  return '|-\n' + body
}

// ─── Combined narrative used by both renderers ───────────────────────────────

function howToUseLines(def: WorkbenchDefinitionView): string[] {
  return [
    `This is a portable playbook generated from the Singularity workbench definition "${def.name}".`,
    'Execute the stages below in order. For each stage: obey its tool policy, do the work described',
    'in its prompt, then produce the stage\'s required documents before advancing. Where a stage',
    'requires approval, pause for a human decision before moving forward. Use SEND_BACK transitions',
    'to return to an earlier stage when its acceptance criteria are not met.',
  ]
}

// ─── .agent.md renderer ──────────────────────────────────────────────────────

export function buildCopilotAgentMd(input: BuildCopilotExportInput): string {
  const { def } = input
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const name = slugify(def.name)
  const description = def.goal?.trim()
    ? firstLine(def.goal, 240)
    : `Governed coding workflow exported from the Singularity workbench "${def.name}".`

  const out: string[] = []

  // ── YAML frontmatter (the part the Copilot CLI parses) ──
  out.push('---')
  out.push(`name: ${yScalar(name)}`)
  out.push(`description: ${yScalar(description)}`)
  out.push('---')
  out.push('')

  // ── Title + provenance ──
  out.push(`# ${def.name}`)
  out.push('')
  out.push(`> Generated ${generatedAt} from Singularity workbench definition \`${def.id}\`.`)
  out.push('> Run with the GitHub Copilot CLI. MCP tools are provided by your CLI environment;')
  out.push('> the tool policy on each stage tells the agent which class of tools it may use.')
  out.push('')

  // ── How to run ──
  out.push('## How to run')
  out.push('')
  for (const l of howToUseLines(def)) out.push(l)
  out.push('')

  // ── Agent learnings / operating constraints ──
  out.push('## Agent learnings & operating constraints')
  out.push('')
  if (def.goal?.trim()) {
    out.push(`- **Goal:** ${def.goal.trim()}`)
  }
  out.push(`- **Max loops per stage:** ${def.maxLoopsPerStage}`)
  out.push(`- **Max total send-backs:** ${def.maxTotalSendBacks}`)
  out.push(`- **Gate mode:** ${def.gateMode}`)
  if (def.sourceUri) {
    out.push(`- **Source:** ${def.sourceType ?? 'repo'} \`${def.sourceUri}\`${def.sourceRef ? ` @ ${def.sourceRef}` : ''}`)
  }
  out.push('')
  // Per-stage learnings distilled from the resolved system prompt + extra context.
  const learningStages = def.stages.filter(s => {
    const p = input.prompts[s.stageKey]
    return p && (p.systemPromptAppend.trim() || p.extraContext.trim())
  })
  if (learningStages.length) {
    out.push('Stage-specific guidance (from the platform\'s prompt layers, including any repository')
    out.push('world-model learnings):')
    out.push('')
    for (const s of learningStages) {
      const p = input.prompts[s.stageKey]!
      out.push(`<details><summary><strong>${s.stageKey}</strong> — guidance</summary>`)
      out.push('')
      if (p.systemPromptAppend.trim()) {
        out.push('```text')
        out.push(p.systemPromptAppend.trim())
        out.push('```')
      }
      if (p.extraContext.trim()) {
        out.push('```text')
        out.push(p.extraContext.trim())
        out.push('```')
      }
      out.push('')
      out.push('</details>')
      out.push('')
    }
  }

  // ── Workflow (stages, in order) ──
  out.push('## Workflow')
  out.push('')
  out.push('Stages run in this order. Respect each stage\'s tool policy and produce its documents')
  out.push('before advancing.')
  out.push('')
  def.stages.forEach((s, i) => {
    const tool = toolPolicyGuidance(s.toolPolicy)
    const tx = transitionsFor(def, s)
    const p = input.prompts[s.stageKey]
    out.push(`### ${i + 1}. ${s.stageKey} — ${s.label}`)
    out.push('')
    out.push(`- **Agent role:** ${s.agentRole}`)
    out.push(`- **Tool policy:** \`${s.toolPolicy}\` — ${tool.summary}`)
    if (tool.tools.length) out.push(`- **Example tools:** ${tool.tools.map(t => `\`${t}\``).join(', ')}`)
    out.push(`- **Context policy:** \`${s.contextPolicy}\` — ${contextPolicyGuidance(s.contextPolicy)}`)
    out.push(`- **Approval required before advancing:** ${s.approvalRequired ? 'yes' : 'no'}`)
    if (s.terminal) out.push('- **Terminal stage:** yes (workflow completes here)')
    if (tx.forward.length) out.push(`- **On success → advance to:** ${tx.forward.join(', ')}`)
    if (tx.sendBack.length) out.push(`- **On rejection → send back to:** ${tx.sendBack.join(', ')}`)
    out.push('')
    out.push('**Prompt:**')
    out.push('')
    if (p && p.resolved && p.task.trim()) {
      out.push(p.task.trim())
    } else {
      out.push(`_(No bound prompt could be resolved for this stage${p?.note ? `: ${p.note}` : ''}. Follow the agent role and the documents below.)_`)
    }
    out.push('')
    if (s.expectedArtifacts.length) {
      out.push('**Documents to create:**')
      out.push('')
      for (const a of s.expectedArtifacts) {
        out.push(`- \`${a.kind}\` — ${a.title} (${a.format}${a.required ? ', required' : ', optional'})${a.description ? ` — ${a.description}` : ''}`)
      }
      out.push('')
    }
  })

  // ── Document creation summary ──
  const allArtifacts = def.stages.flatMap(s => s.expectedArtifacts.map(a => ({ stageKey: s.stageKey, a })))
  if (allArtifacts.length) {
    out.push('## Document creation summary')
    out.push('')
    out.push('| Stage | Document | Title | Format | Required |')
    out.push('| --- | --- | --- | --- | --- |')
    for (const { stageKey, a } of allArtifacts) {
      out.push(`| ${stageKey} | \`${a.kind}\` | ${a.title} | ${a.format} | ${a.required ? 'yes' : 'no'} |`)
    }
    out.push('')
  }

  return out.join('\n')
}

// ─── pure YAML renderer ──────────────────────────────────────────────────────

export function buildCopilotYaml(input: BuildCopilotExportInput): string {
  const { def } = input
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const name = slugify(def.name)
  const description = def.goal?.trim()
    ? firstLine(def.goal, 240)
    : `Governed coding workflow exported from the Singularity workbench "${def.name}".`

  const out: string[] = []
  out.push('apiVersion: singularity.workbench/v1')
  out.push('kind: CopilotWorkflow')
  out.push(`name: ${yScalar(name)}`)
  out.push(`description: ${yScalar(description)}`)
  out.push('generatedFrom:')
  out.push(`  workbenchDefinitionId: ${yScalar(def.id)}`)
  out.push(`  workflowNodeId: ${yScalar(def.workflowNodeId)}`)
  out.push(`  exportedAt: ${yScalar(generatedAt)}`)

  // agentLearnings
  out.push('agentLearnings:')
  out.push(`  goal: ${def.goal?.trim() ? yScalar(def.goal.trim()) : 'null'}`)
  out.push(`  maxLoopsPerStage: ${def.maxLoopsPerStage}`)
  out.push(`  maxTotalSendBacks: ${def.maxTotalSendBacks}`)
  out.push(`  gateMode: ${yScalar(def.gateMode)}`)
  const guidanceStages = def.stages.filter(s => {
    const p = input.prompts[s.stageKey]
    return p && (p.systemPromptAppend.trim() || p.extraContext.trim())
  })
  if (guidanceStages.length) {
    out.push('  perStageGuidance:')
    for (const s of guidanceStages) {
      const p = input.prompts[s.stageKey]!
      out.push(`    - stageKey: ${yScalar(s.stageKey)}`)
      if (p.systemPromptAppend.trim()) {
        out.push(`      systemPrompt: ${yBlock(p.systemPromptAppend, 8)}`)
      }
      if (p.extraContext.trim()) {
        out.push(`      extraContext: ${yBlock(p.extraContext, 8)}`)
      }
    }
  } else {
    out.push('  perStageGuidance: []')
  }

  // workflow
  out.push('workflow:')
  def.stages.forEach(s => {
    const tool = toolPolicyGuidance(s.toolPolicy)
    const tx = transitionsFor(def, s)
    const p = input.prompts[s.stageKey]
    out.push(`  - stageKey: ${yScalar(s.stageKey)}`)
    out.push(`    label: ${yScalar(s.label)}`)
    out.push(`    agentRole: ${yScalar(s.agentRole)}`)
    out.push(`    toolPolicy: ${yScalar(s.toolPolicy)}`)
    out.push(`    toolPolicyGuidance: ${yScalar(tool.summary)}`)
    if (tool.tools.length) {
      out.push(`    exampleTools: [${tool.tools.map(t => yScalar(t)).join(', ')}]`)
    } else {
      out.push('    exampleTools: []')
    }
    out.push(`    contextPolicy: ${yScalar(s.contextPolicy)}`)
    out.push(`    contextPolicyGuidance: ${yScalar(contextPolicyGuidance(s.contextPolicy))}`)
    out.push(`    approvalRequired: ${s.approvalRequired}`)
    out.push(`    terminal: ${s.terminal}`)
    out.push(`    repoAccess: ${s.repoAccess}`)
    const promptText = p && p.resolved ? p.task : ''
    out.push(`    prompt: ${yBlock(promptText, 6)}`)
    if (p && !p.resolved && p.note) {
      out.push(`    promptNote: ${yScalar(p.note)}`)
    }
    out.push('    transitions:')
    out.push(`      forward: [${tx.forward.map(t => yScalar(t)).join(', ')}]`)
    out.push(`      sendBack: [${tx.sendBack.map(t => yScalar(t)).join(', ')}]`)
    if (s.expectedArtifacts.length) {
      out.push('    documents:')
      for (const a of s.expectedArtifacts) {
        out.push(`      - kind: ${yScalar(a.kind)}`)
        out.push(`        title: ${yScalar(a.title)}`)
        out.push(`        format: ${yScalar(a.format)}`)
        out.push(`        required: ${a.required}`)
        if (a.description) out.push(`        description: ${yScalar(a.description)}`)
      }
    } else {
      out.push('    documents: []')
    }
  })

  return out.join('\n') + '\n'
}

// ─── filename helper ─────────────────────────────────────────────────────────

export function exportFilename(def: WorkbenchDefinitionView, format: 'agent-md' | 'yaml'): string {
  const base = slugify(def.name)
  return format === 'yaml' ? `${base}.workflow.yaml` : `${base}.agent.md`
}
