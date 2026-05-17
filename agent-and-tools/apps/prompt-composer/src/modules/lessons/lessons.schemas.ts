/**
 * M38 — request/response schemas for the lessons-learned catalog.
 *
 * Audit-gov's Singularity Engine POSTs to /api/v1/lessons when a confirmed-
 * resolved issue produces a 2-sentence rule from its LLM extraction step.
 * Composer embeds the rule, persists, and returns the lesson id.
 *
 * compose.service.ts pulls top-K active lessons by cosine similarity at
 * assembly time (semanticLessons() peer of semanticMemory/semanticKnowledge).
 */
import { z } from "zod";

export const createLessonSchema = z.object({
  capabilityId: z.string().min(1, "capabilityId required"),
  toolName: z.string().optional(),
  ruleText: z.string().min(10, "ruleText must be at least 10 chars"),
  sourceIssueId: z.string().optional(),
  sourceTraceIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  extractedBy: z.string().optional(),
});

export type CreateLessonInput = z.infer<typeof createLessonSchema>;

export const deactivateLessonSchema = z.object({
  reason: z.string().optional(),
  supersededBy: z.string().uuid().optional(),
});

export interface LessonRow {
  id: string;
  capabilityId: string;
  toolName: string | null;
  ruleText: string;
  sourceIssueId: string | null;
  sourceTraceIds: unknown;
  confidence: number;
  isActive: boolean;
  supersededBy: string | null;
  extractedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
