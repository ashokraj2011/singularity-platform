/**
 * M29 wind-down — in-process agent loop is deprecated. The only remaining
 * supported execution path is:
 *
 *   workgraph AGENT_TASK → context-fabric /execute → mcp-server agent loop
 *
 * `executionService.create`, `.list`, `.get`, and `.getReceipt` remain
 * functional for historical-row queries the admin SPA still surfaces.
 * `executionService.start` is now a deprecation stub — it preserves the
 * HTTP contract (the SPA's runtime-executions page still POSTs to it) but
 * marks the execution FAILED with a clear "moved to workgraph" message.
 *
 * Removing the in-process loop is what unblocks the prompt-composer DB
 * split (Decision 2): the imports of promptAssemblyService and friends
 * are now gone, so prompt-composer can own its tables on its own DB.
 */
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { env } from "../../config/env";
import { Prisma } from "../../../generated/prisma-client";

export const executionService = {
  async create(input: {
    workflowExecutionId?: string; capabilityId?: string;
    agentTemplateId: string; agentBindingId?: string;
    userRequest: string; modelProvider?: string; modelName?: string;
  }, userId?: string) {
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");

    return prisma.agentExecution.create({
      data: {
        workflowExecutionId: input.workflowExecutionId,
        capabilityId: input.capabilityId,
        agentTemplateId: input.agentTemplateId,
        agentBindingId: input.agentBindingId,
        userRequest: input.userRequest,
        modelProvider: input.modelProvider ?? env.DEFAULT_MODEL_PROVIDER,
        modelName: input.modelName ?? env.DEFAULT_MODEL_NAME,
        executionStatus: "CREATED",
        createdBy: userId,
      },
    });
  },

  async list(filter?: { capabilityId?: string; status?: string }) {
    const where: Record<string, unknown> = {};
    if (filter?.capabilityId) where.capabilityId = filter.capabilityId;
    if (filter?.status) where.executionStatus = filter.status;
    return prisma.agentExecution.findMany({
      where,
      orderBy: { createdAt: "desc" }, take: 100,
      include: { agentTemplate: true, capability: true, agentBinding: true },
    });
  },

  async get(id: string) {
    const exec = await prisma.agentExecution.findUnique({
      where: { id },
      include: {
        agentTemplate: true, capability: true, agentBinding: true,
        toolReceipts: true, executionReceipts: true,
      },
    });
    if (!exec) throw new NotFoundError("Execution not found");
    return exec;
  },

  /**
   * @deprecated M29 — in-process execution is no longer supported.
   *
   * Historical behavior: prompt assembly → model call → tool validation →
   * receipts, all run synchronously inside agent-runtime. The new path is:
   *
   *   workgraph AGENT_TASK → context-fabric /execute → mcp-server agent loop
   *
   * To preserve the API contract used by the admin SPA's runtime-executions
   * page, this method still accepts the request and updates the execution
   * row — but marks it FAILED with a clear message instead of running the
   * (removed) in-process loop.
   */
  async start(id: string, _opts: { workflowPhase?: string; task?: string }) {
    const exec = await this.get(id);

    const message = legacyRuntimeMessage(exec.agentTemplateId);

    await prisma.agentExecution.update({
      where: { id },
      data: {
        executionStatus: "FAILED",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    await prisma.agentExecutionReceipt.create({
      data: {
        agentExecutionId: id,
        finalStatus: "FAILED",
        evidenceRefs: legacyRuntimeEvidence(exec.agentTemplateId, message),
        memoryRefs: [],
        approvalRefs: [],
        toolReceiptRefs: [],
      },
    });

    return {
      executionId: id,
      deprecated: true,
      finalStatus: "FAILED" as const,
      message,
      // Preserved fields so the SPA's response decoder doesn't blow up.
      promptAssemblyId: null,
      promptHash: null,
      outputHash: null,
      modelOutput: null,
      toolReceiptIds: [] as string[],
    };
  },

  async getReceipt(id: string) {
    const exec = await this.get(id);
    const receipt = await prisma.agentExecutionReceipt.findFirst({
      where: { agentExecutionId: id },
      orderBy: { createdAt: "desc" },
    });
    return {
      executionId: id,
      executionStatus: exec.executionStatus,
      promptAssemblyId: receipt?.promptAssemblyId ?? null,
      promptHash: receipt?.promptHash ?? null,
      outputHash: receipt?.outputHash ?? null,
      toolReceipts: exec.toolReceipts,
      evidenceRefs: receipt?.evidenceRefs ?? (exec.executionStatus === "FAILED"
        ? legacyRuntimeEvidence(exec.agentTemplateId, legacyRuntimeMessage(exec.agentTemplateId))
        : []),
      memoryRefs: receipt?.memoryRefs ?? [],
      approvalRefs: receipt?.approvalRefs ?? [],
      finalStatus: receipt?.finalStatus ?? (exec.executionStatus === "FAILED" ? "FAILED" : null),
      message: receipt
        ? null
        : exec.executionStatus === "FAILED"
          ? legacyRuntimeMessage(exec.agentTemplateId)
          : null,
      executionPath: "workgraph-context-fabric-mcp",
    };
  },
};

function legacyRuntimeMessage(agentTemplateId: string) {
  return [
    "Direct agent-runtime execution is retired.",
    "Use Workflow Manager to run an AGENT_TASK so the call goes through Workgraph, Prompt Composer, Context Fabric, MCP, budgets, approvals, and Run Insights.",
    `Template: ${agentTemplateId}`,
  ].join(" ");
}

function legacyRuntimeEvidence(agentTemplateId: string, message: string): Prisma.InputJsonValue {
  return [{
    source_kind: "runtime",
    source_id: agentTemplateId,
    citation_key: "runtime:direct-execution-retired",
    content: message,
    confidence: 1,
    metadata: {
      replacement_path: "Workflow Manager -> workflow run -> AGENT_TASK -> Context Fabric /execute -> MCP",
      workgraph_runs_url: "http://localhost:5174/runs",
    },
  }];
}
