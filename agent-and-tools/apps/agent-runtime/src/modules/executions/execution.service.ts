import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { promptAssemblyService } from "../prompts/prompt-assembly.service";
import { modelRuntimeService } from "../model-runtime/model-runtime.service";
import { toolValidationService } from "../tools/tool-validation.service";
import { stubAdapter } from "../tools/tool-adapter.interface";
import { env } from "../../config/env";

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
   * Spec §14.2 — orchestrate prompt assembly → model → tool validation → receipts.
   */
  async start(id: string, opts: { workflowPhase?: string; task?: string }) {
    const exec = await this.get(id);

    await prisma.agentExecution.update({
      where: { id },
      data: { executionStatus: "RUNNING", startedAt: new Date() },
    });

    // 1. Assemble prompt
    const assembly = await promptAssemblyService.assemble({
      agentTemplateId: exec.agentTemplateId,
      agentBindingId: exec.agentBindingId ?? undefined,
      capabilityId: exec.capabilityId ?? undefined,
      workflowExecutionId: exec.workflowExecutionId ?? undefined,
      workflowPhase: opts.workflowPhase,
      task: opts.task ?? exec.userRequest ?? "Analyze the request.",
      modelProvider: exec.modelProvider ?? env.DEFAULT_MODEL_PROVIDER,
      modelName: exec.modelName ?? env.DEFAULT_MODEL_NAME,
    }, id);

    await prisma.agentExecution.update({
      where: { id },
      data: { executionStatus: "PROMPT_ASSEMBLED" },
    });

    // 2. Run model
    const modelOutput = await modelRuntimeService.run({
      modelProvider: exec.modelProvider ?? env.DEFAULT_MODEL_PROVIDER,
      modelName: exec.modelName ?? env.DEFAULT_MODEL_NAME,
      messages: [
        { role: "system", content: assembly.finalPromptPreview ?? "" },
        { role: "user", content: opts.task ?? exec.userRequest ?? "" },
      ],
    });

    // 3. Tool calls → validate → execute → receipts
    const toolReceiptIds: string[] = [];
    if (modelOutput.toolCalls && modelOutput.toolCalls.length > 0) {
      for (const call of modelOutput.toolCalls) {
        const validation = await toolValidationService.validate({
          agentExecutionId: id,
          agentTemplateId: exec.agentTemplateId,
          agentBindingId: exec.agentBindingId ?? undefined,
          capabilityId: exec.capabilityId ?? undefined,
          toolName: call.name,
          workflowPhase: opts.workflowPhase,
          input: call.input,
        });

        const dot = call.name.indexOf(".");
        const ns = dot >= 0 ? call.name.slice(0, dot) : "";
        const nm = dot >= 0 ? call.name.slice(dot + 1) : call.name;
        const tool = await prisma.toolDefinition.findFirst({ where: { namespace: ns, name: nm } });

        if (!validation.allowed || !tool) {
          if (tool) {
            const receipt = await prisma.toolExecutionReceipt.create({
              data: {
                agentExecutionId: id, toolId: tool.id, toolName: call.name,
                inputHash: sha256(call.input as object),
                status: "BLOCKED", errorMessage: validation.reason,
                startedAt: new Date(), completedAt: new Date(),
              },
            });
            toolReceiptIds.push(receipt.id);
          }
          continue;
        }

        if (validation.requiresApproval) {
          const receipt = await prisma.toolExecutionReceipt.create({
            data: {
              agentExecutionId: id, toolId: tool.id, toolName: call.name,
              inputHash: sha256(call.input as object),
              status: "WAITING_APPROVAL", startedAt: new Date(),
            },
          });
          toolReceiptIds.push(receipt.id);
          continue;
        }

        const startedAt = new Date();
        const result = await stubAdapter.execute({
          toolName: call.name,
          input: call.input,
          context: {
            agentExecutionId: id, agentTemplateId: exec.agentTemplateId,
            agentBindingId: exec.agentBindingId ?? undefined,
            capabilityId: exec.capabilityId ?? undefined,
            workflowExecutionId: exec.workflowExecutionId ?? undefined,
            workflowPhase: opts.workflowPhase,
            userId: exec.createdBy ?? undefined,
          },
        });
        const receipt = await prisma.toolExecutionReceipt.create({
          data: {
            agentExecutionId: id, toolId: tool.id, toolName: call.name,
            inputHash: sha256(call.input as object),
            outputHash: result.output ? sha256(result.output as object) : null,
            status: result.success ? "SUCCESS" : "ERROR",
            errorMessage: result.error,
            startedAt, completedAt: new Date(),
          },
        });
        toolReceiptIds.push(receipt.id);
      }
    }

    // 4. Final execution receipt
    const finalText = modelOutput.text ?? "";
    const outputHash = sha256(finalText);
    const finalStatus = "COMPLETED";

    await prisma.agentExecutionReceipt.create({
      data: {
        agentExecutionId: id,
        promptAssemblyId: assembly.promptAssemblyId,
        promptHash: assembly.finalPromptHash,
        outputHash,
        toolReceiptRefs: toolReceiptIds as Prisma.InputJsonValue,
        evidenceRefs: [] as Prisma.InputJsonValue,
        memoryRefs: [] as Prisma.InputJsonValue,
        approvalRefs: [] as Prisma.InputJsonValue,
        finalStatus,
      },
    });

    await prisma.agentExecution.update({
      where: { id },
      data: { executionStatus: finalStatus, completedAt: new Date() },
    });

    return {
      executionId: id,
      promptAssemblyId: assembly.promptAssemblyId,
      promptHash: assembly.finalPromptHash,
      outputHash,
      finalStatus,
      modelOutput,
      toolReceiptIds,
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
      evidenceRefs: receipt?.evidenceRefs ?? [],
      memoryRefs: receipt?.memoryRefs ?? [],
      approvalRefs: receipt?.approvalRefs ?? [],
      finalStatus: receipt?.finalStatus ?? null,
    };
  },
};
