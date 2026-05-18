/**
 * M42.1 — Receipt skeleton.
 *
 * Build, persist, and emit a hash-chained receipt for a single codegen
 * run. M42.1 only records the spec + IR + template + generator version
 * tuple; M42.2-M42.4 grow it with `generatedArtifacts[]`, `gaps[]`,
 * `llmTasks[]`, `patchHashes[]`. Patent Chain E builds on this exact
 * shape.
 *
 * `receiptHash` is sha256 of the canonicalised receipt body, so
 * external auditors can recompute and verify offline.
 */
import { canonicalize } from '../spec/canonicalize.js'
import { sha256 } from '../spec/hash.js'
import { prisma } from '../lib/prisma.js'
import { config } from '../config.js'
import { emitAudit } from './emit.js'
import type { ApplicationIr } from '../ir/types.js'

export interface BuildReceiptInput {
  specId: string
  specName: string
  specVersion: string
  specHash: string
  ir: ApplicationIr
  workItemId?: string | null
  actorId?: string
}

export interface ReceiptBody {
  receiptVersion: '1.0.0'
  generatedAt: string
  spec: {
    id: string
    name: string
    version: string
    hash: string
  }
  ir: {
    hash: string
    application: ApplicationIr['application']
    endpointCount: number
    modelCount: number
    dataSourceCount: number
    coverage: Array<{ operationId: string; coverage: string }>
  }
  generator: {
    version: string
    templateVersion: string
  }
  // M42.2+ fills in:
  generatedArtifacts?: Array<{ path: string; contentHash: string; protected: boolean }>
  gaps?: Array<{ id: string; type: string; severity: string }>
  llmTasks?: Array<{ id: string; type: string; promptHash: string }>
  patchHashes?: string[]
  workItemId?: string | null
}

export interface PersistedReceipt {
  runId: string
  receiptHash: string
  body: ReceiptBody
}

export async function buildAndPersistReceipt(input: BuildReceiptInput): Promise<PersistedReceipt> {
  // Create the codegen_runs row first — receipts are 1:1 with runs.
  const run = await prisma.codegenRun.create({
    data: {
      specId: input.specId,
      irHash: input.ir.meta.irHash,
      templateVersion: input.ir.meta.templateVersion,
      generatorVersion: input.ir.meta.generatorVersion,
      status: 'STARTED',  // M42.2 will flip to GENERATED, etc.
    },
  })

  const body: ReceiptBody = {
    receiptVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    spec: {
      id: input.specId,
      name: input.specName,
      version: input.specVersion,
      hash: input.specHash,
    },
    ir: {
      hash: input.ir.meta.irHash,
      application: input.ir.application,
      endpointCount: input.ir.endpoints.length,
      modelCount: input.ir.models.length,
      dataSourceCount: input.ir.dataSources.length,
      coverage: input.ir.endpoints.map(e => ({
        operationId: e.operationId,
        coverage: e.businessLogicCoverage,
      })),
    },
    generator: {
      version: input.ir.meta.generatorVersion,
      templateVersion: input.ir.meta.templateVersion,
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

  // Best-effort audit fan-out so audit-gov has the spec→IR→run lineage
  // recorded in the canonical event timeline.
  await emitAudit({
    event: 'codegen.run.started',
    subjectKind: 'CodegenRun',
    subjectId: run.id,
    actorId: input.actorId,
    payload: {
      specId: input.specId,
      specHash: input.specHash,
      irHash: input.ir.meta.irHash,
      generatorVersion: config.GENERATOR_VERSION,
      templateVersion: input.ir.meta.templateVersion,
      receiptHash,
    },
  })

  return { runId: run.id, receiptHash, body }
}
