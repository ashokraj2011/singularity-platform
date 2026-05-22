import { BlueprintStageStatus } from '@prisma/client'
import {
  contextFabricClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type PendingApproval,
} from '../../lib/context-fabric/client'

export type CodingStagePolicy = 'planning' | 'design' | 'developer' | 'qa' | 'certify'
export type CodingRunStatus = 'COMPLETED' | 'FAILED' | 'PAUSED' | 'DENIED'

export interface CodingRunRequest {
  sessionId: string
  stageKey: string
  stageLabel?: string
  attemptId: string
  actorId?: string
  policy: CodingStagePolicy
  executeRequest: ExecuteRequest
}

export interface CodingRunResult {
  status: CodingRunStatus
  executeStatus: ExecuteResponse['status']
  response: ExecuteResponse
  policy: CodingStagePolicy
  pendingApproval?: PendingApproval | null
  codeChangeIds: string[]
  verificationReceipts: VerificationReceiptSummary[]
  modelUsage: ExecuteResponse['modelUsage']
  tokensUsed: ExecuteResponse['tokensUsed']
  warnings: string[]
}

export interface VerificationReceiptSummary {
  id?: string
  command?: string
  passed?: boolean
  exitCode?: number
  unavailable?: boolean
  source: 'tool' | 'artifact' | 'unknown'
}

export async function runCodingStage(input: CodingRunRequest): Promise<CodingRunResult> {
  const response = await contextFabricClient.execute(input.executeRequest)
  return normalizeCodingRunResult(response, input.policy)
}

export async function resumeCodingStage(input: {
  cfCallId?: string
  continuationToken?: string
  decision: 'approved' | 'rejected'
  reason?: string
  argsOverride?: Record<string, unknown>
  policy: CodingStagePolicy
}): Promise<CodingRunResult> {
  const response = await contextFabricClient.resume({
    cf_call_id: input.cfCallId,
    continuation_token: input.continuationToken,
    decision: input.decision,
    reason: input.reason,
    args_override: input.argsOverride,
  })
  return normalizeCodingRunResult(response, input.policy)
}

export function normalizeCodingRunResult(response: ExecuteResponse, policy: CodingStagePolicy): CodingRunResult {
  const executeStatus = response.status
  const status: CodingRunStatus =
    executeStatus === 'WAITING_APPROVAL' ? 'PAUSED'
      : executeStatus === 'FAILED' ? 'FAILED'
        : executeStatus === 'DENIED' || executeStatus === 'REJECTED' ? 'DENIED'
          : 'COMPLETED'

  return {
    status,
    executeStatus,
    response,
    policy,
    pendingApproval: response.pendingApproval ?? null,
    codeChangeIds: codeChangeIdsFrom(response),
    verificationReceipts: verificationReceiptsFrom(response),
    modelUsage: response.modelUsage,
    tokensUsed: response.tokensUsed,
    warnings: response.warnings ?? [],
  }
}

export function blueprintStageStatusFor(result: CodingRunResult): BlueprintStageStatus {
  if (result.status === 'FAILED' || result.status === 'DENIED') return BlueprintStageStatus.FAILED
  // The relational enum has no PAUSED state today. Keep the DB row open while
  // Workbench attempt metadata carries the precise PAUSED status + token.
  if (result.status === 'PAUSED') return BlueprintStageStatus.RUNNING
  return BlueprintStageStatus.COMPLETED
}

export function attemptStatusFor(result: CodingRunResult): 'COMPLETED' | 'FAILED' | 'PAUSED' {
  if (result.status === 'PAUSED') return 'PAUSED'
  if (result.status === 'FAILED' || result.status === 'DENIED') return 'FAILED'
  return 'COMPLETED'
}

export function isTerminalCodingResult(result: CodingRunResult): boolean {
  return result.status !== 'PAUSED'
}

export function classifyCodingStagePolicy(input: { key?: string; label?: string; agentRole?: string; terminal?: boolean }): CodingStagePolicy {
  const signature = `${input.key ?? ''} ${input.label ?? ''} ${input.agentRole ?? ''}`.toLowerCase()
  if (signature.includes('develop') || signature.includes('developer') || signature.includes('engineer') || signature.includes('code')) return 'developer'
  if (signature.includes('certif') || signature.includes('signoff') || signature.includes('sign-off') || input.terminal) return 'certify'
  if (signature.includes('qa') || signature.includes('quality') || signature.includes('test') || signature.includes('verif')) return 'qa'
  if (signature.includes('design') || signature.includes('architect')) return 'design'
  return 'planning'
}

export function stageRequiresVerification(policy: CodingStagePolicy): boolean {
  return policy === 'developer' || policy === 'qa' || policy === 'certify'
}

export function hasActualCodeChange(result: CodingRunResult): boolean {
  return result.codeChangeIds.length > 0
}

export function hasVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.length > 0
}

export function hasPassingVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt => receipt.passed === true || receipt.exitCode === 0)
}

export function hasFailedVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt =>
    !receipt.unavailable && (receipt.passed === false || (typeof receipt.exitCode === 'number' && receipt.exitCode !== 0)),
  )
}

export function hasUnavailableVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt => receipt.unavailable === true)
}

function codeChangeIdsFrom(response: ExecuteResponse): string[] {
  return (response.correlation?.codeChangeIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

function verificationReceiptsFrom(response: ExecuteResponse): VerificationReceiptSummary[] {
  const receipts: VerificationReceiptSummary[] = []
  const seen = new Set<string>()
  const candidates = [
    response.verificationReceipts,
    response.correlation,
    response.correlation?.verificationReceipts,
    response.workspace,
    response.usage,
    response.metrics,
    response.prompt,
  ]
  for (const candidate of candidates) {
    collectVerificationReceipts(candidate, receipts, seen)
  }
  return receipts
}

function collectVerificationReceipts(value: unknown, out: VerificationReceiptSummary[], seen: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectVerificationReceipts(item, out, seen)
    return
  }
  const record = value as Record<string, unknown>
  const kind = String(record.kind ?? record.type ?? '').toLowerCase()
  const verificationKind = String(record.verification_kind ?? '').toLowerCase()
  // M68.1 — Exclude the formal-verifier's own block-result receipts from
  // cross-stage threading. mcp-server's auto-finish at invoke.ts:2580
  // pushes a `{verification_kind:"formal", passed:false, ...}` entry onto
  // state.verificationReceipts whenever the gate blocks, so the agent's
  // repair loop can see WHY it was blocked. That's useful in-session.
  // But the summary gets saved into BlueprintSession.metadata
  // .verificationReceiptHistory and threaded to every future stage as
  // priorVerificationReceipts — and because the gate uses receipts.every(
  // passed), a single blocked stage poisons every subsequent stage's
  // gate forever. Filter formal-kind receipts here so they stay
  // in-session-only. Real run_test/run_command receipts (kind="test",
  // "command", etc.) still flow through.
  if (verificationKind === 'formal') return
  const looksLikeVerification =
    kind === 'verification_result' ||
    kind === 'test_result' ||
    Boolean(record.command && ('exit_code' in record || 'exitCode' in record || 'passed' in record))
  if (looksLikeVerification) {
    const id = typeof record.id === 'string' ? record.id : undefined
    const key = id ?? JSON.stringify({
      command: record.command,
      exit: record.exit_code ?? record.exitCode,
      passed: record.passed,
    })
    if (!seen.has(key)) {
      seen.add(key)
      out.push({
        id,
        command: typeof record.command === 'string' ? record.command : undefined,
        passed: typeof record.passed === 'boolean' ? record.passed : undefined,
        exitCode: typeof record.exit_code === 'number'
          ? record.exit_code
          : typeof record.exitCode === 'number'
            ? record.exitCode
            : undefined,
        unavailable: record.unavailable === true || record.verification_kind === 'unavailable',
        source: kind ? 'tool' : 'unknown',
      })
    }
    return
  }
  for (const item of Object.values(record)) collectVerificationReceipts(item, out, seen)
}
