/**
 * Local tool registry.
 *
 * In v0 this is a hard-coded set of safe tools, useful for smoke-testing the
 * LLM↔tool loop without external dependencies. In v1 the registry is
 * populated by syncing from `tool-service` (filtered to tools with
 * execution_target=LOCAL for this capability).
 *
 * A "local tool" runs inside this MCP server process. Customer-side tools
 * (filesystem, GitHub, internal HTTP APIs) belong here and never round-trip
 * through our cloud.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  natural_language: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requires_approval: boolean;
}

export interface ToolHandler {
  descriptor: ToolDescriptor;
  execute(args: Record<string, unknown>): Promise<{
    output: unknown;
    success: boolean;
    error?: string;
  }>;
}

const echoTool: ToolHandler = {
  descriptor: {
    name: "echo",
    description: "Echoes the input text back, prefixed with 'echo:'.",
    natural_language:
      "Use this when the user asks you to echo, repeat, or repeat-back a piece of text exactly.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo" },
      },
      required: ["text"],
    },
    output_schema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const text = typeof args.text === "string" ? args.text : "";
    return { success: true, output: { text: `echo: ${text}` } };
  },
};

const nowTool: ToolHandler = {
  descriptor: {
    name: "current_time",
    description: "Returns the current ISO-8601 UTC timestamp.",
    natural_language:
      "Use this when the user asks for the current time, date, timestamp, or 'what time is it'.",
    input_schema: { type: "object", properties: {} },
    output_schema: {
      type: "object",
      properties: { now: { type: "string", format: "date-time" } },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute() {
    return { success: true, output: { now: new Date().toISOString() } };
  },
};

// Approval-gated test tool — exercises the M9.z pause/resume flow.
// Realistic example: a tool that sends an external notification or kicks off
// a billable action. The agent loop pauses on this; an operator approves or
// rejects via /mcp/resume.
const notifyAdminTool: ToolHandler = {
  descriptor: {
    name: "notify_admin",
    description: "Send a high-priority notification to the on-call admin. Approval-gated.",
    natural_language:
      "Use this only when the user explicitly asks to escalate, page, or notify the admin or on-call.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short summary" },
        body: { type: "string", description: "Full message body" },
      },
      required: ["subject"],
    },
    output_schema: {
      type: "object",
      properties: { delivered_at: { type: "string", format: "date-time" } },
    },
    risk_level: "HIGH",
    requires_approval: true,
  },
  async execute(args) {
    const subject = typeof args.subject === "string" ? args.subject : "(no subject)";
    return {
      success: true,
      output: {
        delivered_at: new Date().toISOString(),
        subject,
        delivered_to: "admin@example.com",
      },
    };
  },
};

const REGISTRY = new Map<string, ToolHandler>([
  [echoTool.descriptor.name, echoTool],
  [nowTool.descriptor.name, nowTool],
  [notifyAdminTool.descriptor.name, notifyAdminTool],
]);

export function listLocalTools(): ToolDescriptor[] {
  return Array.from(REGISTRY.values()).map((t) => t.descriptor);
}

export function getLocalTool(name: string): ToolHandler | undefined {
  return REGISTRY.get(name);
}
