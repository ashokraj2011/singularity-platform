/**
 * M42.5 — Brownfield receipt builder (spec §25.16).
 *
 * Greenfield receipts anchor on (specHash, irHash, templateVersion,
 * generatorVersion). Brownfield receipts anchor on a different tuple
 * because there is no IR — the change is plan-driven:
 *
 *   (repoModelHash, enhancementSpecHash, changePlanHash, patchHashes)
 *
 * The receipt body also carries the §25.16 evidence block listing
 * applied files, recipe notes, and the LLM patch task ids the
 * dispatcher seeded. Auditors recompute receiptHash = sha256(canonical(body))
 * and verify the chain.
 *
 * Persistence shape:
 *   - CodegenSpec row of kind='code_enhancement' to hold the enhancement
 *     spec (with its canonical JSON + hash).
 *   - CodegenRun row with mode=BROWNFIELD, brownfieldPlanId=plan.id,
 *     specId pointing at the enhancement spec row, status=COMPLETED
 *     when the dispatcher succeeded.
 *   - CodegenReceipt row 1:1 with the run.
 *   - CodegenLlmPatchTask rows for each LLM task seed.
 *   - CodegenArtifact rows for each file the dispatcher wrote.
 */
import { canonicalize } from '../spec/canonicalize.js'
import { sha256 } from '../spec/hash.js'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { emitAudit } from './emit.js'
import type { ChangePlan, EnhancementSpec } from '../brownfield/types.js'
import type { DispatchOutcome } from '../brownfield/dispatcher.js'
import type { LlmTaskSeed } from '../brownfield/recipes/registry.js'

export interface BrownfieldReceiptInput {
  repoModelId: string
  repoModelHash: string
  changePlanId: string
  enhancementSpec: EnhancementSpec
  enhancementSpecHash: string
  plan: ChangePlan
  planHash: string
  outputPath: string
  outcome: DispatchOutcome
  actorId?: string | null
  workItemId?: string | null
}

export interface BrownfieldReceiptBody {
  receiptVersion: '1.0.0'
  receiptKind: 'brownfield'
  generatedAt: string
  enhancement: {
    type: string
    targetEndpoint: string
    targetModel: string
    field: { name: string; type: string; required?: boolean }
  }
  hashes: {
    repoModelHash: string
    enhancementSpecHash: string
    changePlanHash: string
    patchHashes: string[]   // per-file afterHash[] from the dispatcher
  }
  generator: {
    version: string
  }
  evidence: {
    appliedFiles: Array<{ path: string; beforeHash: string | null; afterHash: string; bytes: number }>
    recipeNotes: string[]
    llmTaskCount: number
    unresolvedCount: number
  }
  workItemId?: string | null
}

export interface PersistedBrownfieldReceipt {
  runId: string
  receiptHash: string
  body: BrownfieldReceiptBody
  llmTaskIds: string[]
}

export async function persistBrownfieldReceipt(
  input: BrownfieldReceiptInput,
): Promise<PersistedBrownfieldReceipt> {
  // 1) Persist the enhancement spec as a CodegenSpec row (kind=code_enhancement).
  //    Idempotent by specName+version: re-applying the same plan reuses the row.
  const specName = input.enhancementSpec.metadata.workItemId
    ?? `enhancement-${input.changePlanId.slice(0, 8)}`
  const version = input.enhancementSpec.specVersion ?? '1.0.0'
  const canonical = canonicalize(input.enhancementSpec)
  const existingSpec = await prisma.codegenSpec.findUnique({
    where: { specName_version: { specName, version } },
  })
  const specRow = existingSpec
    ? await prisma.codegenSpec.update({
        where: { id: existingSpec.id },
        data: { specHash: input.enhancementSpecHash, canonicalJson: JSON.parse(canonical) as unknown as object },
      })
    : await prisma.codegenSpec.create({
        data: {
          specName,
          version,
          kind: 'code_enhancement',
          state: 'FROZEN',
          yaml: canonical,                                          // canonical JSON as the source-of-truth blob
          canonicalJson: JSON.parse(canonical) as unknown as object,
          specHash: input.enhancementSpecHash,
          workItemId: input.workItemId ?? null,
          createdById: input.actorId ?? null,
        },
      })

  // 2) Create the brownfield CodegenRun.
  const status = input.outcome.status === 'OK'
    ? (input.outcome.unresolvedOperations.length === 0 ? 'COMPLETED' : 'PATCHED')
    : (input.outcome.status === 'BLOCKED' ? 'FAILED' : 'FAILED')
  const run = await prisma.codegenRun.create({
    data: {
      specId: specRow.id,
      irHash: input.enhancementSpecHash,           // brownfield: no IR; reuse the enhancement hash as the run anchor
      templateVersion: 'brownfield-recipe-1.0.0',
      generatorVersion: config.GENERATOR_VERSION,
      status,
      mode: 'BROWNFIELD',
      brownfieldPlanId: input.changePlanId,
      outputPath: input.outputPath,
      completedAt: new Date(),
    },
  })

  // 3) Persist artifact rows for every file the dispatcher actually wrote.
  if (input.outcome.edits.length > 0) {
    await prisma.codegenArtifact.createMany({
      data: input.outcome.edits.map(e => ({
        runId: run.id,
        path: e.filePath,
        contentHash: e.afterHash,
        fileType: classifyFile(e.filePath),
        generatedBy: 'brownfield-recipe',
        protected: false,
      })),
      skipDuplicates: true,
    })
  }

  // 4) Persist CodegenLlmPatchTask rows for each seed the recipes emitted.
  const llmTaskIds: string[] = []
  for (const seed of input.outcome.llmTasks) {
    const row = await prisma.codegenLlmPatchTask.create({
      data: {
        runId: run.id,
        gapId: null,
        taskType: mapTaskType(seed),
        status: 'PENDING',
        targetFile: seed.targetFile,
        targetClass: seed.targetClass ?? null,
        targetMethod: seed.targetMethod ?? null,
        regionId: seed.regionId,
        allowedChanges: seed.allowedChanges,
        forbiddenChanges: seed.forbiddenChanges,
        metadata: (seed.metadata ?? {}) as object,
      },
    })
    llmTaskIds.push(row.id)
  }

  // 5) Build + persist the receipt body.
  const body: BrownfieldReceiptBody = {
    receiptVersion: '1.0.0',
    receiptKind: 'brownfield',
    generatedAt: new Date().toISOString(),
    enhancement: {
      type: input.enhancementSpec.enhancement.type,
      targetEndpoint: input.enhancementSpec.enhancement.targetEndpoint,
      targetModel: input.enhancementSpec.enhancement.targetModel,
      field: input.enhancementSpec.field,
    },
    hashes: {
      repoModelHash: input.repoModelHash,
      enhancementSpecHash: input.enhancementSpecHash,
      changePlanHash: input.planHash,
      patchHashes: input.outcome.edits.map(e => e.afterHash),
    },
    generator: { version: config.GENERATOR_VERSION },
    evidence: {
      appliedFiles: input.outcome.edits.map(e => ({
        path: e.filePath,
        beforeHash: e.beforeHash,
        afterHash: e.afterHash,
        bytes: e.bytesWritten,
      })),
      recipeNotes: input.outcome.recipeNotes,
      llmTaskCount: llmTaskIds.length,
      unresolvedCount: input.outcome.unresolvedOperations.length,
    },
    workItemId: input.workItemId ?? null,
  }
  const receiptHash = sha256(canonicalize(body))
  await prisma.codegenReceipt.create({
    data: {
      runId: run.id,
      receiptJson: body as unknown as object,
      receiptHash,
    },
  })

  // 6) Audit fan-out — best-effort.
  await emitAudit({
    event: 'codegen.brownfield.applied',
    subjectKind: 'CodegenRun',
    subjectId: run.id,
    actorId: input.actorId ?? undefined,
    payload: {
      enhancementType: input.enhancementSpec.enhancement.type,
      repoModelHash: input.repoModelHash,
      enhancementSpecHash: input.enhancementSpecHash,
      changePlanHash: input.planHash,
      receiptHash,
      llmTaskCount: llmTaskIds.length,
      unresolvedCount: input.outcome.unresolvedOperations.length,
    },
  })

  return { runId: run.id, receiptHash, body, llmTaskIds }
}

function classifyFile(path: string): string {
  if (/\.ya?ml$/.test(path)) return 'contract'
  if (/(?:^|\/)test|Test\.java$|\.test\.tsx?$|\.spec\.tsx?$|^tests\//.test(path)) return 'test'
  if (/\/model\/|Dto\.|Response\.java$|schema\.ts$/.test(path)) return 'source'
  return 'source'
}

function mapTaskType(seed: LlmTaskSeed): 'COMPLETE_MAPPING_LOGIC' | 'UPDATE_TEST_ASSERTIONS' {
  // The recipe seeds already use the enum strings — passthrough.
  return seed.taskType
}
