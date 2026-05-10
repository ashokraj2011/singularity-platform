export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelRunInput {
  modelProvider: string;
  modelName: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelRunOutput {
  text?: string;
  toolCalls?: ModelToolCall[];
  raw?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  name: string;
  run(input: ModelRunInput): Promise<ModelRunOutput>;
}
