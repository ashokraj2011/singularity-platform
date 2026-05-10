export interface ToolExecutionContext {
  agentExecutionId: string;
  agentTemplateId: string;
  agentBindingId?: string;
  capabilityId?: string;
  workflowExecutionId?: string;
  workflowPhase?: string;
  environment?: string;
  userId?: string;
}

export interface ToolAdapterInput {
  toolName: string;
  input: unknown;
  context: ToolExecutionContext;
}

export interface ToolAdapterOutput {
  success: boolean;
  output?: unknown;
  error?: string;
  evidenceRefs?: string[];
}

export interface ToolAdapter {
  canHandle(toolName: string): boolean;
  execute(input: ToolAdapterInput): Promise<ToolAdapterOutput>;
}

/**
 * Stub adapter — echoes the input back as a successful "result". Replace per-tool with real adapters.
 */
export const stubAdapter: ToolAdapter = {
  canHandle: () => true,
  async execute({ toolName, input }: ToolAdapterInput): Promise<ToolAdapterOutput> {
    return {
      success: true,
      output: { message: `Stub adapter for ${toolName}`, echoedInput: input },
      evidenceRefs: [],
    };
  },
};
