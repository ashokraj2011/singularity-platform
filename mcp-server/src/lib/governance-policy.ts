import type { PendingToolDescriptor } from "../audit/pending";

const MUTATION_TOOL_NAMES = new Set([
  "write_file",
  "write_file_demo",
  "apply_patch",
  "apply_patch_demo",
  "edit_file",
  "create_file",
  "git_commit",
  "finish_work_branch",
]);

function toolRisk(desc?: PendingToolDescriptor): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  return desc?.risk_level ?? "LOW";
}

export function isMutationTool(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(name);
}

export function isRiskyToolByPolicy(name: string, desc?: PendingToolDescriptor): boolean {
  return isMutationTool(name) || desc?.execution_target === "SERVER" || desc?.requires_approval === true || ["HIGH", "CRITICAL"].includes(toolRisk(desc));
}

export function isDegradedToolAllowedByPolicy(
  name: string,
  desc?: PendingToolDescriptor,
  degradedActionsAllowed: string[] = [],
): boolean {
  if (degradedActionsAllowed.length > 0 && !degradedActionsAllowed.includes(name)) return false;
  if (desc?.execution_target === "SERVER") return false;
  if (isMutationTool(name)) return false;
  return toolRisk(desc) === "LOW";
}
