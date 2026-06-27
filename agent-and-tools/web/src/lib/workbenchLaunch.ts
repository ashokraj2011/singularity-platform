export type WorkbenchLaunchView =
  | "cockpit"
  | "artifacts"
  | "code-review"
  | "stage-chat"
  | "milestones"
  | "export"
  | "audit"
  | "governance"
  | "loop-theater";

export type WorkbenchLaunchInput = {
  workflowInstanceId?: string | null;
  browserRunId?: string | null;
  workflowNodeId?: string | null;
  phaseId?: string | null;
  goal?: string | null;
  sourceType?: "github" | "localdir" | string | null;
  sourceUri?: string | null;
  sourceRef?: string | null;
  capabilityId?: string | null;
  architectAgentTemplateId?: string | null;
  developerAgentTemplateId?: string | null;
  qaAgentTemplateId?: string | null;
  gateMode?: "manual" | "auto" | string | null;
  loopDefinition?: unknown;
};

export function isWorkbenchProfile(profile?: string | null): boolean {
  return String(profile ?? "").trim().toLowerCase() === "workbench";
}

export function workbenchNeoUrl(input: WorkbenchLaunchInput, view: WorkbenchLaunchView = "cockpit"): string {
  const params = new URLSearchParams();
  const workflowInstanceId = cleanParam(input.workflowInstanceId);
  const browserRunId = cleanParam(input.browserRunId) ?? workflowInstanceId;
  setParam(params, "workflowInstanceId", workflowInstanceId);
  setParam(params, "browserRunId", browserRunId);
  setParam(params, "workflowNodeId", input.workflowNodeId);
  setParam(params, "phaseId", input.phaseId);
  setParam(params, "goal", input.goal);
  if (input.sourceType === "github" || input.sourceType === "localdir") params.set("sourceType", input.sourceType);
  setParam(params, "sourceUri", input.sourceUri);
  setParam(params, "sourceRef", input.sourceRef);
  setParam(params, "capabilityId", input.capabilityId);
  setParam(params, "architectAgentTemplateId", input.architectAgentTemplateId);
  setParam(params, "developerAgentTemplateId", input.developerAgentTemplateId);
  setParam(params, "qaAgentTemplateId", input.qaAgentTemplateId);
  if (input.gateMode === "manual" || input.gateMode === "auto") params.set("gateMode", input.gateMode);
  if (input.loopDefinition !== undefined) {
    try {
      params.set("loopDefinition", JSON.stringify(input.loopDefinition));
    } catch {
      // A malformed optional loop definition should not block the cockpit link.
    }
  }
  params.set("ui", "neo");
  const query = params.toString();
  return `/workbench/${view}${query ? `?${query}` : ""}`;
}

function setParam(params: URLSearchParams, key: string, value?: string | null) {
  const clean = cleanParam(value);
  if (clean) params.set(key, clean);
}

function cleanParam(value?: string | null): string | undefined {
  const text = value?.trim();
  if (!text || /\{\{[^}]+}}/.test(text)) return undefined;
  return text;
}
