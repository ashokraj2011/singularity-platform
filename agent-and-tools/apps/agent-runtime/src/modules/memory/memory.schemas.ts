import { z } from "zod";

export const storeExecutionMemorySchema = z.object({
  workflowExecutionId: z.string().min(1),
  capabilityId: z.string().uuid().optional(),
  agentBindingId: z.string().uuid().optional(),
  memoryType: z.string().min(2),
  title: z.string().optional(),
  content: z.string().min(1),
  evidenceRefs: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const promoteSchema = z.object({
  sourceMemoryIds: z.array(z.string().uuid()).min(1),
  scopeType: z.string().min(2),
  scopeId: z.string().min(1),
  memoryType: z.string().min(2),
  title: z.string().min(2),
  content: z.string().min(1),
  approvedBy: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "CANDIDATE"]),
});
