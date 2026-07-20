/**
 * The exported Copilot workflow must carry the capability world model.
 *
 * An off-platform / laptop run has to be grounded the same way an in-platform one
 * is. The grounding is EMBEDDED, inside each `stages[].prompt`, rather than
 * referenced by a URL the runner would resolve at run time. That is deliberate:
 *
 *   • The runner invokes `copilot -p "<prompt>"`. The prompt string is the only
 *     thing that reaches the CLI, so anything in a sibling YAML key is inert
 *     unless the runner splices it back in.
 *   • The file's own header promises `stages[].prompt` is tool-agnostic — "run
 *     them in whatever tool you like". Grounding kept outside the prompt would be
 *     silently lost by every tool except the bundled runner, which is precisely
 *     the silent-degradation failure this work exists to fix.
 *   • A handoff targets a laptop that may have no platform connectivity or token,
 *     so a fetch-on-run reference cannot be relied on. The export is already a
 *     self-contained bundle by design (full artifact content, diffs, templates
 *     and the runner script are all embedded).
 *
 * The cost accepted is duplication across stages and point-in-time staleness —
 * both inherent to a per-stage `copilot -p` model, where each prompt must stand
 * alone.
 *
 * `buildCopilotWorkflowExport` is pure, so this needs no Postgres, no
 * context-fabric and no network.
 */
import { describe, it, expect } from 'vitest'
import { buildCopilotWorkflowExport } from '../src/modules/workflow/instances.router'

// A realistic grounding block: the shape context-fabric's render_grounding_block
// emits — markdown headings, backticked commands, and blank lines between
// sections. All three are things a naive YAML emitter can mangle.
const GROUNDING = [
  '## Capability grounding',
  '',
  '### Development View [development]',
  '',
  'Start in src/index.ts. Follow the repo AGENTS.md rules.',
  '',
  '### Capability facts',
  '',
  '- Primary language: typescript',
  '- Build system: pnpm',
  '- Test commands: `pnpm test`, `pnpm lint`',
].join('\n')

const COMPOSED_PROMPT = [
  'You are working DIRECTLY in a Git repository already cloned to your current working directory.',
  '',
  'You are acting as the **developer** for this stage of the SDLC.',
  '',
  '## Your task',
  'Add a health endpoint.',
  '',
  GROUNDING,
].join('\n')

function stage(over: Partial<Parameters<typeof buildCopilotWorkflowExport>[1]['stages'][number]> = {}) {
  return {
    key: 'DEVELOP',
    nodeId: 'node-dev',
    label: 'Implement the change',
    nodeType: 'AGENT_TASK',
    role: 'developer',
    prompt: 'Add a health endpoint.',
    reads: [],
    produces: [],
    ...over,
  }
}

function build(over: { composed?: Map<string, string> } = {}) {
  return buildCopilotWorkflowExport(
    {
      id: 'run-1',
      name: 'SDLC run',
      context: { _vars: {}, _globals: { sourceRef: 'main' }, workBranch: 'wi/ABC-1' },
    },
    { stages: [stage()], repo: 'https://github.com/acme/app.git', story: 'A story', workCode: 'ABC-1' },
    { composedByNodeId: over.composed ?? new Map([['node-dev', COMPOSED_PROMPT]]) },
  )
}

describe('copilot export carries the capability world model', () => {
  it('embeds the grounding block in the exported YAML', () => {
    const { yaml } = build()

    expect(yaml).toContain('## Capability grounding')
    expect(yaml).toContain('### Development View [development]')
    expect(yaml).toContain('- Build system: pnpm')
    // The repo's own agent rules are the whole point — this is what a copilot
    // stage was previously ignoring.
    expect(yaml).toContain('Follow the repo AGENTS.md rules.')
  })

  it('keeps the grounding inside the stage prompt literal block', () => {
    const { yaml } = build()
    const lines = yaml.split('\n')

    const promptIdx = lines.findIndex(l => l.trim() === 'prompt: |')
    expect(promptIdx).toBeGreaterThan(-1)

    const groundingIdx = lines.findIndex(l => l.includes('## Capability grounding'))
    expect(groundingIdx).toBeGreaterThan(promptIdx)

    // Every non-empty line of the block is indented past the `prompt: |` key, so
    // the markdown cannot break out of the scalar and become YAML structure.
    for (let i = promptIdx + 1; i <= groundingIdx; i++) {
      if (!lines[i].trim()) continue
      expect(lines[i].startsWith('      ')).toBe(true)
    }
  })

  it('preserves the blank lines that separate grounding sections', () => {
    const { yaml } = build()
    // render_grounding_block separates sections with a blank line; if those were
    // dropped the markdown would collapse into one run-on block.
    expect(yaml).toContain('      ### Capability facts\n\n      - Primary language: typescript')
  })

  it('grounds every runnable stage, not just the first', () => {
    const stages = [stage(), stage({ key: 'TEST', nodeId: 'node-qa', role: 'tester' })]
    const { yaml } = buildCopilotWorkflowExport(
      { id: 'run-1', name: 'SDLC run', context: {} },
      { stages, repo: 'r', story: '', workCode: 'ABC-1' },
      {
        composedByNodeId: new Map([
          ['node-dev', COMPOSED_PROMPT],
          ['node-qa', COMPOSED_PROMPT],
        ]),
      },
    )
    // Each stage runs as its own `copilot -p` invocation, so each prompt must
    // stand alone — the duplication is the price of that, not an accident.
    expect(yaml.split('## Capability grounding').length - 1).toBe(2)
  })

  it('documents that the prompts are self-contained', () => {
    const { yaml } = build()
    expect(yaml).toContain('SELF-CONTAINED')
    expect(yaml).toContain('world model')
  })

  it('degrades to the raw task without failing the export', () => {
    // context-fabric could not compose (agent-runtime down, CF timeout): the
    // export still has to produce a runnable file rather than erroring.
    const { yaml, stageCount } = build({ composed: new Map() })

    expect(stageCount).toBe(1)
    expect(yaml).toContain('Add a health endpoint.')
    expect(yaml).not.toContain('## Capability grounding')
  })
})
