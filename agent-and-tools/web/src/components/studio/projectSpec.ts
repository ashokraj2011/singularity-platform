import { workgraphFetch } from "@/lib/workgraph";

/**
 * Shared types + save helper for a Specification Project's shared upstream (analysis + design).
 * Mirrors the workgraph-api studio-spec schemas. Section patches carry the loaded revision so
 * two editors can't silently clobber each other (the API 409s on a stale revision).
 */

export type Goal = { text: string; metric?: string };
export type Stakeholder = { name: string; role?: string; concern?: string };
export type Analysis = {
  problem: string;
  goals: Goal[];
  stakeholders: Stakeholder[];
  assumptions: string[];
  constraints: string[];
};
export type RequirementPriority = "MUST" | "SHOULD" | "MAY";
export type Requirement = {
  id: string;
  statement: string;
  priority: RequirementPriority;
  acceptanceCriteria: string[];
  rationale?: string;
};
export type DecisionStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "REJECTED";
export type Decision = {
  id: string;
  title: string;
  status: DecisionStatus;
  context?: string;
  decision: string;
  consequences?: string;
};
export type ProjectSpecPackage = { analysis: Analysis; requirements: Requirement[]; decisions: Decision[] };
export type ProjectSpec = { projectId: string; revision: number; package: ProjectSpecPackage; updatedAt?: string };

export const emptyAnalysis: Analysis = { problem: "", goals: [], stakeholders: [], assumptions: [], constraints: [] };

// Project-level reconciliation roll-up (read-only).
export type ReconCounts = { pass: number; partial: number; fail: number };
export type ReconRunView = { id: string; status: string; mode: string; counts: ReconCounts; startedAt?: string; completedAt?: string | null } | null;
export type ProjectReconItem = {
  workItem: { id: string; workCode?: string | null; title?: string | null; status?: string | null };
  latestRun: ReconRunView;
};
export type ProjectReconciliation = {
  items: ProjectReconItem[];
  rollup: { itemsTotal: number; itemsReconciled: number; pass: number; partial: number; fail: number };
};

export function specKey(projectId: string): string {
  return `/studio/projects/${projectId}/specification`;
}
export function reconKey(projectId: string): string {
  return `/studio/projects/${projectId}/reconciliation`;
}

export async function patchSection(
  projectId: string,
  section: "analysis" | "requirements" | "decisions",
  value: unknown,
  expectedRevision: number,
): Promise<ProjectSpec> {
  return workgraphFetch<ProjectSpec>(specKey(projectId), {
    method: "PATCH",
    body: JSON.stringify({ section, value, expectedRevision }),
  });
}
