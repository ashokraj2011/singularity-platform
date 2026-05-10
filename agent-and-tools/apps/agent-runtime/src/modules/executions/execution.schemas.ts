import { z } from "zod";

export const createExecutionSchema = z.object({
  workflowExecutionId: z.string().optional(),
  capabilityId: z.string().uuid().optional(),
  agentTemplateId: z.string().uuid(),
  agentBindingId: z.string().uuid().optional(),
  userRequest: z.string().min(1),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
  workflowPhase: z.string().optional(),
});

export const startExecutionSchema = z.object({
  workflowPhase: z.string().optional(),
  task: z.string().optional(),
});
