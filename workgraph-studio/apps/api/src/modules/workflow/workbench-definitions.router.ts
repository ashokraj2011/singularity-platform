/**
 * M84.s2 — REST surface for first-class workbench definitions.
 *
 * Mounted at /api/workflow-nodes/:nodeId/workbench in app.ts.
 *
 * Endpoints (all gated by assertInstancePermission on the node's
 * parent instance — view for GET, edit for POST/PATCH/DELETE):
 *
 *   GET    /                              — full definition tree
 *   PATCH  /                              — top-level fields
 *   POST   /stages                        — append stage
 *   PATCH  /stages/:stageId               — edit stage
 *   DELETE /stages/:stageId               — remove stage (cascades)
 *   POST   /stages/reorder                — bulk reorder by id list
 *   POST   /stages/:stageId/artifacts     — add artifact
 *   PATCH  /artifacts/:artifactId         — edit artifact
 *   DELETE /artifacts/:artifactId         — remove artifact
 *   POST   /edges                         — create FORWARD or SEND_BACK
 *   DELETE /edges/:edgeId                 — remove edge
 *   POST   /consumes                      — pin a handoff (inferred=false)
 *   DELETE /consumes/:consumesId          — remove handoff binding
 *
 * All write paths return the updated full view so the UI can
 * re-render without a follow-up GET.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
// NotFoundError no longer needed at the router level — service throws
// it for genuinely-missing nodes; an empty definition returns an
// empty-shell view instead of 404.
import * as service from './workbench-definitions.service'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { promptComposerClient, PromptComposerError } from '../../lib/prompt-composer/client'
import {
  buildCopilotAgentMd,
  buildCopilotYaml,
  exportFilename,
  type ExportStagePrompt,
} from './workbench-copilot-export'

export const workbenchDefinitionsRouter: Router = Router({ mergeParams: true })

// mergeParams pulls :nodeId from the parent mount (app.ts), but the
// TS handler type sees `req.params` as the local-only shape and
// doesn't know about merged params. Cast in one place so the routes
// stay readable.
function nodeIdOf(req: Request): string {
  return (req.params as Record<string, string>).nodeId
}

function runTenantScoped<T>(callback: () => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, callback)
}

// ─── Zod schemas ───────────────────────────────────────────────────────────

const policyEnum = z.enum(['NONE', 'READ_ONLY', 'MUTATION', 'VERIFICATION'])
const contextEnum = z.enum(['NONE', 'STORY_ONLY', 'REPO_READ_ONLY', 'CODE_EDIT', 'VERIFY_ONLY', 'EVIDENCE_REVIEW'])
const formatEnum = z.enum(['MARKDOWN', 'TEXT', 'JSON', 'CODE'])
const edgeKindEnum = z.enum(['FORWARD', 'SEND_BACK'])

const patchDefinitionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  goal: z.string().max(8_000).nullable().optional(),
  sourceType: z.enum(['github', 'localdir']).nullable().optional(),
  sourceUri: z.string().max(2_000).nullable().optional(),
  sourceRef: z.string().max(200).nullable().optional(),
  capabilityId: z.string().uuid().nullable().optional(),
  architectAgentTemplateId: z.string().uuid().nullable().optional(),
  developerAgentTemplateId: z.string().uuid().nullable().optional(),
  qaAgentTemplateId: z.string().uuid().nullable().optional(),
  maxLoopsPerStage: z.number().int().min(1).max(20).optional(),
  maxTotalSendBacks: z.number().int().min(0).max(50).optional(),
  gateMode: z.enum(['manual', 'auto']).optional(),
  finalPackKey: z.string().max(200).nullable().optional(),
})

// M91.C (2026-05-27) — Cross-field validation. Pre-M91.C the operator
// could pick combinations that the runtime would silently override
// (e.g. `contextPolicy=STORY_ONLY` paired with `toolPolicy=MUTATION`
// shipped MUTATION tools but the source-materializer skipped the
// repo materialization for STORY_ONLY, producing a broken stage).
// These two enums must move together — these helpers enforce the
// pairing at the save boundary so the designer fields stop being
// decorative AND mismatched.
const VALID_PAIRS: ReadonlyArray<{ ctx: string; tool: string }> = [
  // The five canonical pairings + EVIDENCE_REVIEW (read-only inspection).
  { ctx: 'NONE',            tool: 'NONE' },
  { ctx: 'STORY_ONLY',      tool: 'NONE' },
  { ctx: 'REPO_READ_ONLY',  tool: 'READ_ONLY' },
  { ctx: 'CODE_EDIT',       tool: 'MUTATION' },
  { ctx: 'VERIFY_ONLY',     tool: 'VERIFICATION' },
  { ctx: 'EVIDENCE_REVIEW', tool: 'READ_ONLY' },
]

function validatePolicyPair(
  contextPolicy: string | undefined,
  toolPolicy: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  // Both unset → defer to seed-level defaults (legacy back-compat).
  if (!contextPolicy && !toolPolicy) return { ok: true }
  // Only one set → reject; the pair is required to land together so a
  // designer can't half-configure into a broken state.
  if (contextPolicy && !toolPolicy) {
    return {
      ok: false,
      reason:
        `contextPolicy=${contextPolicy} requires toolPolicy. Valid pairs: ` +
        VALID_PAIRS.map(p => `${p.ctx}+${p.tool}`).join(', '),
    }
  }
  if (toolPolicy && !contextPolicy) {
    return {
      ok: false,
      reason:
        `toolPolicy=${toolPolicy} requires contextPolicy. Valid pairs: ` +
        VALID_PAIRS.map(p => `${p.ctx}+${p.tool}`).join(', '),
    }
  }
  // Both set → must be a valid pairing.
  const ok = VALID_PAIRS.some(p => p.ctx === contextPolicy && p.tool === toolPolicy)
  if (!ok) {
    return {
      ok: false,
      reason:
        `Invalid policy pair: contextPolicy=${contextPolicy} + toolPolicy=${toolPolicy}. ` +
        `Valid pairs: ${VALID_PAIRS.map(p => `${p.ctx}+${p.tool}`).join(', ')}. ` +
        `These two enums must move together — see M91.A StageExecutionPolicy.`,
    }
  }
  return { ok: true }
}

const createStageSchema = z.object({
  stageKey: z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/, 'stageKey must be UPPER_SNAKE_CASE'),
  label: z.string().min(1).max(200),
  agentRole: z.string().min(1).max(80),
  agentTemplateId: z.string().uuid().nullable().optional(),
  promptProfileKey: z.string().max(200).nullable().optional(),
  toolPolicy: policyEnum.optional(),
  contextPolicy: contextEnum.optional(),
  required: z.boolean().optional(),
  terminal: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  repoAccess: z.boolean().optional(),
  positionX: z.number().nullable().optional(),
  positionY: z.number().nullable().optional(),
  // G8 — per-stage governance intent (reconciled into IAM scope=STAGE attachments).
  governancePolicyId: z.string().nullable().optional(),
  governanceEnforcement: z.enum(['ADVISORY', 'REQUIRED', 'BLOCKING']).nullable().optional(),
  governancePriority: z.number().int().nullable().optional(),
}).superRefine((data, ctx) => {
  // M91.C — pair validation. Refuses STORY_ONLY+MUTATION, etc.
  const r = validatePolicyPair(data.contextPolicy, data.toolPolicy)
  if (!r.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toolPolicy'],
      message: r.reason,
    })
  }
})

// patchStageSchema relaxes required-ness but keeps the pair-validation
// when both fields are present in the partial.
const patchStageSchema = z.object({
  stageKey: z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  label: z.string().min(1).max(200).optional(),
  agentRole: z.string().min(1).max(80).optional(),
  agentTemplateId: z.string().uuid().nullable().optional(),
  promptProfileKey: z.string().max(200).nullable().optional(),
  toolPolicy: policyEnum.optional(),
  contextPolicy: contextEnum.optional(),
  required: z.boolean().optional(),
  terminal: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  repoAccess: z.boolean().optional(),
  positionX: z.number().nullable().optional(),
  positionY: z.number().nullable().optional(),
  governancePolicyId: z.string().nullable().optional(),
  governanceEnforcement: z.enum(['ADVISORY', 'REQUIRED', 'BLOCKING']).nullable().optional(),
  governancePriority: z.number().int().nullable().optional(),
}).superRefine((data, ctx) => {
  // Only validate when BOTH fields appear in the patch. A patch that
  // only updates one of them is allowed — the missing one is assumed
  // to match the stage's existing value (caller can read-modify-write
  // if they want to ensure consistency).
  if (data.contextPolicy !== undefined && data.toolPolicy !== undefined) {
    const r = validatePolicyPair(data.contextPolicy, data.toolPolicy)
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolPolicy'],
        message: r.reason,
      })
    }
  }
})

const reorderSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1),
})

const createArtifactSchema = z.object({
  kind: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/, 'kind must be lower_snake_case'),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  format: formatEnum.optional(),
  required: z.boolean().optional(),
  editable: z.boolean().optional(),
  // M102 — optional catalog ArtifactTemplate link (set by the designer picker).
  templateId: z.string().max(120).nullable().optional(),
})

const patchArtifactSchema = createArtifactSchema.partial()

const createQuestionSchema = z.object({
  questionId: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/, 'questionId must be lower_snake_case'),
  text: z.string().min(1).max(2_000),
  required: z.boolean().optional(),
  freeform: z.boolean().optional(),
  options: z.any().optional(),
})
const patchQuestionSchema = createQuestionSchema.partial()

const createEdgeSchema = z.object({
  fromStageId: z.string().uuid(),
  toStageId: z.string().uuid(),
  kind: edgeKindEnum,
  label: z.string().max(200).nullable().optional(),
})

const pinConsumesSchema = z.object({
  consumerStageId: z.string().uuid(),
  producerArtifactId: z.string().uuid(),
  required: z.boolean().optional(),
})

// ─── Routes ────────────────────────────────────────────────────────────────

workbenchDefinitionsRouter.get('/', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.getDefinition(nodeIdOf(req), req.user!.userId))
    if (!view) {
      // M84.s2-followup — return an empty-shell instead of 404 when
      // the node exists but has no definition yet. The UI distinguishes
      // "no stages yet, please add some" from "node doesn't exist" by
      // checking stages.length. 404 still fires for an actual missing
      // node (caught inside getDefinition before reaching here).
      res.json({
        data: {
          id: null,
          workflowNodeId: nodeIdOf(req),
          name: 'Workbench loop',
          version: 1,
          stages: [],
          edges: [],
          consumes: [],
          empty: true,
        },
      })
      return
    }
    res.json({ data: view })
  } catch (err) { next(err) }
})

// M97 — Build the Mustache vars the stage prompt templates expect, from the
// *static* definition (no runtime session). prompt-composer's task templates
// reference {{goal}}, {{stageKey}}, {{artifacts}}, etc.; without these the
// exported prompt renders with empty placeholders. We mirror the key names
// from blueprint.router.ts:buildLoopStageVars so the same DB-managed templates
// fill in cleanly. Runtime-only fields (operator chat, prior attempts, captured
// decisions) get their natural empty-state lines — there is no live session to
// draw them from at export time.
function buildExportStageVars(
  def: service.WorkbenchDefinitionView,
  stage: service.WorkbenchStageView,
): Record<string, string> {
  const repoAware = stage.repoAccess
  const artifacts = stage.expectedArtifacts.length
    ? stage.expectedArtifacts
        .map(a => `- ${a.title} (${a.kind})${a.required ? ' [required]' : ''}${a.description ? `: ${a.description}` : ''}`)
        .join('\n')
    : '- No explicit artifact contract; produce the stage default artifact pack.'
  const questions = stage.questions.length
    ? stage.questions.map(q => `- ${q.questionId}: ${q.text}${q.required ? ' (required)' : ''}`).join('\n')
    : '- No configured questions.'
  const isDeveloperStage = stage.agentRole.toUpperCase().includes('DEV')
  const implementationDirective = isDeveloperStage
    ? [
        'Use the approved artifact context as the implementation backlog for this attempt.',
        'If the Goal is generic, derive the concrete change from Story Intake, Plan, and Design artifacts instead of asking the operator to restate the task.',
        'If the approved behavior already exists in code, make a verifiable codebase change such as focused tests or documentation updates that prove the accepted contract.',
        'A Developer attempt is not approvable until MCP returns a real code_change receipt plus verification evidence.',
      ].join(' ')
    : ''
  return {
    goal: def.goal ?? '',
    stageKey: stage.stageKey,
    stageLabel: stage.label,
    agentRole: stage.agentRole,
    stageDescription: stage.label || 'No description supplied.',
    artifacts,
    questions,
    latestAccepted: 'No accepted stages yet.',
    priorApprovedArtifacts: '- No prior approved artifacts (static export).',
    implementationDirective,
    capturedDecisions: '- No stakeholder decisions captured yet.',
    sendBacks: '- No send-backs yet.',
    stageContextPolicy: stage.contextPolicy,
    stageToolPolicy: stage.toolPolicy,
    stageRepoAccess: repoAware ? 'true' : 'false',
    promptProfileKey: stage.promptProfileKey ?? '',
    sourceType: repoAware ? def.sourceType ?? '' : '',
    sourceUri: repoAware ? def.sourceUri ?? '' : '',
    sourceRef: repoAware ? def.sourceRef ?? '' : '',
    sourceRefSuffix: repoAware && def.sourceRef ? ` @ ${def.sourceRef}` : '',
    operatorChat: '- No operator guidance.',
    priorAttemptLearnings: '',
    priorAttemptAnnotations: '',
  }
}

// M97 — Export the workbench definition as a single portable GitHub Copilot
// playbook. `?format=agent-md` (default) returns a `.agent.md` custom-agent
// file the Copilot CLI runs directly; `?format=yaml` returns a pure structured
// playbook for callers with their own harness. MCP/tools are supplied by the
// operator's CLI environment — the file only names the per-stage tool policy.
workbenchDefinitionsRouter.get('/export-copilot', async (req, res, next) => {
  try {
    const nodeId = nodeIdOf(req)
    const format = (req.query.format === 'yaml' ? 'yaml' : 'agent-md') as 'agent-md' | 'yaml'

    const def = await runTenantScoped(() => service.getDefinition(nodeId, req.user!.userId))
    if (!def || def.stages.length === 0) {
      res.status(404).json({
        error: {
          code: 'NO_WORKBENCH_DEFINITION',
          message: 'This node has no workbench stages to export yet.',
        },
      })
      return
    }

    // Resolve each stage's prompt in parallel. A single failed resolve must
    // not sink the whole export — fall back to a noted placeholder so the
    // operator still gets a usable file (and can see which stage is unbound).
    const prompts: Record<string, ExportStagePrompt> = {}
    await Promise.all(
      def.stages.map(async stage => {
        try {
          const r = await promptComposerClient.resolveStage({
            stageKey: stage.stageKey,
            agentRole: stage.agentRole,
            promptProfileKey: stage.promptProfileKey ?? undefined,
            vars: buildExportStageVars(def, stage),
          })
          prompts[stage.stageKey] = {
            task: r.task ?? '',
            systemPromptAppend: r.systemPromptAppend ?? '',
            extraContext: r.extraContext ?? '',
            resolved: true,
          }
        } catch (err) {
          const note =
            err instanceof PromptComposerError
              ? `prompt-composer ${err.status}`
              : 'prompt-composer unavailable'
          prompts[stage.stageKey] = {
            task: '',
            systemPromptAppend: '',
            extraContext: '',
            resolved: false,
            note,
          }
        }
      }),
    )

    const body =
      format === 'yaml'
        ? buildCopilotYaml({ def, prompts })
        : buildCopilotAgentMd({ def, prompts })

    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(def, format)}"`)
    res.setHeader('Content-Type', format === 'yaml' ? 'application/x-yaml; charset=utf-8' : 'text/markdown; charset=utf-8')
    res.send(body)
  } catch (err) {
    next(err)
  }
})

workbenchDefinitionsRouter.patch('/', validate(patchDefinitionSchema), async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.patchDefinition(
      nodeIdOf(req),
      req.body as z.infer<typeof patchDefinitionSchema>,
      req.user!.userId,
    ))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/stages', validate(createStageSchema), async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.createStage(
      nodeIdOf(req),
      req.body as z.infer<typeof createStageSchema>,
      req.user!.userId,
    ))
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/stages/reorder', validate(reorderSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof reorderSchema>
    const view = await runTenantScoped(() => service.reorderStages(nodeIdOf(req), body.stageIds, req.user!.userId))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.patch('/stages/:stageId', validate(patchStageSchema), async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.patchStage(
      nodeIdOf(req),
      req.params.stageId!,
      req.body as z.infer<typeof patchStageSchema>,
      req.user!.userId,
    ))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/stages/:stageId', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.deleteStage(nodeIdOf(req), req.params.stageId!, req.user!.userId))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post(
  '/stages/:stageId/artifacts',
  validate(createArtifactSchema),
  async (req, res, next) => {
    try {
      const view = await runTenantScoped(() => service.createArtifact(
        nodeIdOf(req),
        req.params.stageId!,
        req.body as z.infer<typeof createArtifactSchema>,
        req.user!.userId,
      ))
      res.status(201).json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.patch(
  '/artifacts/:artifactId',
  validate(patchArtifactSchema),
  async (req, res, next) => {
    try {
      const view = await runTenantScoped(() => service.patchArtifact(
        nodeIdOf(req),
        req.params.artifactId!,
        req.body as z.infer<typeof patchArtifactSchema>,
        req.user!.userId,
      ))
      res.json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.delete('/artifacts/:artifactId', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.deleteArtifact(
      nodeIdOf(req),
      req.params.artifactId!,
      req.user!.userId,
    ))
    res.json({ data: view })
  } catch (err) { next(err) }
})

// ─── Questions ───────────────────────────────────────────────────────────────
workbenchDefinitionsRouter.post(
  '/stages/:stageId/questions',
  validate(createQuestionSchema),
  async (req, res, next) => {
    try {
      const view = await runTenantScoped(() => service.createQuestion(
        nodeIdOf(req),
        req.params.stageId!,
        req.body as z.infer<typeof createQuestionSchema>,
        req.user!.userId,
      ))
      res.status(201).json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.patch(
  '/questions/:questionId',
  validate(patchQuestionSchema),
  async (req, res, next) => {
    try {
      const view = await runTenantScoped(() => service.patchQuestion(
        nodeIdOf(req),
        req.params.questionId!,
        req.body as z.infer<typeof patchQuestionSchema>,
        req.user!.userId,
      ))
      res.json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.delete('/questions/:questionId', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.deleteQuestion(
      nodeIdOf(req),
      req.params.questionId!,
      req.user!.userId,
    ))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/edges', validate(createEdgeSchema), async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.createEdge(
      nodeIdOf(req),
      req.body as z.infer<typeof createEdgeSchema>,
      req.user!.userId,
    ))
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/edges/:edgeId', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.deleteEdge(nodeIdOf(req), req.params.edgeId!, req.user!.userId))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/consumes', validate(pinConsumesSchema), async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.pinConsumes(
      nodeIdOf(req),
      req.body as z.infer<typeof pinConsumesSchema>,
      req.user!.userId,
    ))
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/consumes/:consumesId', async (req, res, next) => {
  try {
    const view = await runTenantScoped(() => service.deleteConsumes(
      nodeIdOf(req),
      req.params.consumesId!,
      req.user!.userId,
    ))
    res.json({ data: view })
  } catch (err) { next(err) }
})
