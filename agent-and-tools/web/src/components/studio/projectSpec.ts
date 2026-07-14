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
export type DecisionStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "REJECTED";
export type Decision = {
  id: string;
  title: string;
  status: DecisionStatus;
  context?: string;
  decision: string;
  consequences?: string;
};
export type ProjectSpecPackage = { analysis: Analysis; decisions: Decision[] };
export type ProjectSpec = { projectId: string; revision: number; package: ProjectSpecPackage; updatedAt?: string };

export const emptyAnalysis: Analysis = { problem: "", goals: [], stakeholders: [], assumptions: [], constraints: [] };

export function specKey(projectId: string): string {
  return `/studio/projects/${projectId}/specification`;
}

export async function patchSection(
  projectId: string,
  section: "analysis" | "decisions",
  value: unknown,
  expectedRevision: number,
): Promise<ProjectSpec> {
  return workgraphFetch<ProjectSpec>(specKey(projectId), {
    method: "PATCH",
    body: JSON.stringify({ section, value, expectedRevision }),
  });
}
