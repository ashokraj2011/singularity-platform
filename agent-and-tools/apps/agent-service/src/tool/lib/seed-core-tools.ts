/**
 * M18 — core-toolkit seeder.
 *
 * Registers the always-on tools in `tool.tools` on tool-service startup.
 * Idempotent: an existing (tool_name, version) row is left alone (we don't
 * overwrite operator edits like allowed_capabilities or status changes).
 *
 * Two execution targets:
 *   - "mcp" (custom): tool runs in mcp-server's local registry. tool-service
 *     publishes the contract for discovery; the agent loop on mcp-server
 *     dispatches the call locally.
 *   - "server": tool runs inside tool-service via /internal-tools/<name>.
 *     The execution.ts server path POSTs to runtime.endpoint_url.
 */
import { query } from "../database";
import { capabilityMetadataForTool } from "./capability-metadata";

const VERSION = "1.0.0";
const INTERNAL_BASE   = process.env.INTERNAL_TOOLS_BASE_URL    ?? "http://agent-service:3001/api/v1/internal-tools";
const CONNECTOR_BASE  = process.env.CONNECTOR_TOOLS_BASE_URL   ?? "http://agent-service:3001/api/v1/connector-tools";

interface SeedTool {
  name: string;
  display: string;
  description: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  runtime: Record<string, unknown>;
  executionTarget: "LOCAL" | "SERVER";
  tags: string[];
  metadata?: Record<string, unknown>;
}

const SEEDS: SeedTool[] = [
  // ── mcp-server LOCAL tools (M18 + M16 promoted to discoverable) ───────────
  {
    name: "read_file", display: "Read File", riskLevel: "low", requiresApproval: false,
    description: "Read a sandboxed file and return its text contents.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, max_bytes: { type: "number" } }, required: ["path"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "read_file" },
    executionTarget: "LOCAL", tags: ["fs", "core"],
  },
  {
    name: "list_directory", display: "List Directory", riskLevel: "low", requiresApproval: false,
    description: "List entries of a sandboxed directory; skips node_modules/.git/etc.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" }, max_entries: { type: "number" } }, required: ["path"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "list_directory" },
    executionTarget: "LOCAL", tags: ["fs", "core"],
  },
  {
    name: "search_code", display: "Search Code", riskLevel: "low", requiresApproval: false,
    description: "Ripgrep search across the sandbox; returns file:line:text for matches.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean" }, path: { type: "string" }, glob: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "search_code" },
    executionTarget: "LOCAL", tags: ["code", "core"],
  },
  {
    name: "http_get", display: "HTTP GET", riskLevel: "medium", requiresApproval: false,
    description: "HTTP GET a URL; returns the response text or JSON.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, as_json: { type: "boolean" }, max_bytes: { type: "number" }, headers: { type: "object" } }, required: ["url"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "http_get" },
    executionTarget: "LOCAL", tags: ["http", "core"],
  },
  {
    name: "web_fetch", display: "Web Fetch", riskLevel: "medium", requiresApproval: false,
    description: "Fetch a web page and extract the readable article text (strips nav/ads).",
    inputSchema: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "number" } }, required: ["url"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "web_fetch" },
    executionTarget: "LOCAL", tags: ["http", "core"],
  },
  {
    name: "write_file", display: "Write File", riskLevel: "medium", requiresApproval: false,
    description: "Create or overwrite a file under the MCP sandbox root with complete file contents, not a diff.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "Complete new file body. Use apply_patch for unified diffs." } }, required: ["path", "content"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "write_file" },
    executionTarget: "LOCAL", tags: ["fs", "code", "core"],
  },
  {
    name: "apply_patch", display: "Apply Patch", riskLevel: "medium", requiresApproval: false,
    description: "Apply a unified diff patch under the MCP sandbox root.",
    inputSchema: { type: "object", properties: { patch: { type: "string", description: "Unified diff patch text" } }, required: ["patch"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "apply_patch" },
    executionTarget: "LOCAL", tags: ["fs", "code", "core"],
  },
  {
    name: "replace_text", display: "Replace Text", riskLevel: "medium", requiresApproval: false,
    description: "Replace exact anchor text inside an existing MCP sandbox file; fails without mutation when the anchor is missing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        occurrence: { oneOf: [{ type: "string", enum: ["first", "all"] }, { type: "number" }] },
      },
      required: ["path", "oldText", "newText"],
    },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "replace_text" },
    executionTarget: "LOCAL", tags: ["fs", "code", "core"],
  },
  {
    name: "replace_range", display: "Replace Range", riskLevel: "medium", requiresApproval: false,
    description: "Replace an inclusive 1-based line range inside an existing MCP sandbox file; fails without mutation on invalid ranges.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        replacement: { type: "string" },
      },
      required: ["path", "startLine", "endLine", "replacement"],
    },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "replace_range" },
    executionTarget: "LOCAL", tags: ["fs", "code", "core"],
  },
  {
    name: "git_commit", display: "Git Commit", riskLevel: "medium", requiresApproval: false,
    description: "Stage all dirty files under the sandbox and commit with the given message.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, author: { type: "string" } }, required: ["message"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "git_commit" },
    executionTarget: "LOCAL", tags: ["git", "code", "core"],
  },
  {
    name: "run_command", display: "Run Command", riskLevel: "medium", requiresApproval: false,
    description: "Run an allowlisted non-shell command inside the MCP sandbox and return stdout/stderr evidence.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeout_ms: { type: "number" }, max_output_chars: { type: "number" } }, required: ["command"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "run_command" },
    executionTarget: "LOCAL", tags: ["command", "verification", "code", "core"],
  },
  {
    name: "run_test", display: "Run Test", riskLevel: "medium", requiresApproval: false,
    description: "Run an allowlisted test, lint, typecheck, or verification command inside the MCP sandbox and return a verification receipt.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeout_ms: { type: "number" }, max_output_chars: { type: "number" } }, required: ["command"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "run_test" },
    executionTarget: "LOCAL", tags: ["test", "verification", "code", "core"],
  },
  {
    name: "formal_verify", display: "Formal Verify", riskLevel: "medium", requiresApproval: false,
    description: "Run a formal verification query through the configured verifier and return a structured solver receipt.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        facts: { type: "object" },
        constraints: { type: "array", items: { type: "object" } },
        query: { type: "object" },
        artifactRefs: { type: "array", items: { type: "object" } },
        timeoutMs: { type: "number" },
      },
      required: ["scope", "facts", "query"],
    },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "formal_verify" },
    executionTarget: "LOCAL", tags: ["formal", "verification", "code", "core"],
  },
  {
    name: "verification_unavailable", display: "Verification Unavailable", riskLevel: "low", requiresApproval: false,
    description: "Record an explicit receipt when no runnable test, lint, typecheck, or formal verification command exists.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        inspected: { type: "array", items: { type: "string" } },
        attemptedCommands: { type: "array", items: { type: "string" } },
        paths_context: { type: "array", items: { type: "string" } },
      },
      required: ["reason"],
    },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "verification_unavailable" },
    executionTarget: "LOCAL", tags: ["verification", "code", "core"],
  },
  // ── tool-service SERVER tools (M18) ───────────────────────────────────────
  {
    name: "recall_memory", display: "Recall Memory", riskLevel: "low", requiresApproval: false,
    description: "Semantic search over distilled memory for the active capability. Returns top-k hits with cosine + recency-boost score.",
    inputSchema: { type: "object", properties: { capability_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["capability_id", "query"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${INTERNAL_BASE}/recall_memory`, method: "POST" },
    executionTarget: "SERVER", tags: ["memory", "rag", "core"],
  },
  {
    name: "search_knowledge", display: "Search Knowledge", riskLevel: "low", requiresApproval: false,
    description: "Semantic search over capability knowledge artifacts (docs, READMEs, uploaded files).",
    inputSchema: { type: "object", properties: { capability_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["capability_id", "query"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${INTERNAL_BASE}/search_knowledge`, method: "POST" },
    executionTarget: "SERVER", tags: ["knowledge", "rag", "core"],
  },
  {
    name: "search_symbols", display: "Search Code Symbols", riskLevel: "low", requiresApproval: false,
    description: "Semantic search over extracted code symbols (functions, classes, methods) for the active capability.",
    inputSchema: { type: "object", properties: { capability_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["capability_id", "query"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${INTERNAL_BASE}/search_symbols`, method: "POST" },
    executionTarget: "SERVER", tags: ["code", "rag", "core"],
  },
  {
    name: "summarise_text", display: "Summarise Text", riskLevel: "low", requiresApproval: false,
    description: "Summarise an arbitrary piece of text into a single concise paragraph through MCP-routed LLM execution.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, max_chars: { type: "number" } }, required: ["text"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${INTERNAL_BASE}/summarise_text`, method: "POST" },
    executionTarget: "SERVER", tags: ["llm", "core"],
  },
  {
    name: "extract_entities", display: "Extract Entities", riskLevel: "low", requiresApproval: false,
    description: "Extract named entities (people / orgs / dates / amounts / identifiers) from text into structured JSON.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, kinds: { type: "array", items: { type: "string" } } }, required: ["text"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${INTERNAL_BASE}/extract_entities`, method: "POST" },
    executionTarget: "SERVER", tags: ["llm", "nlp", "core"],
  },
  // ── M19 — connector-as-tool wrappers (proxy workgraph /api/connectors/:id/invoke) ──
  {
    name: "connector_invoke", display: "Connector Invoke (generic)", riskLevel: "medium", requiresApproval: false,
    description: "Generic connector call — pick any registered connector by name and invoke any operation it supports. Use the typed wrappers (send_slack_message etc) when you can; this is the escape hatch.",
    inputSchema: { type: "object", properties: { connector_name: { type: "string" }, operation: { type: "string" }, params: { type: "object" } }, required: ["connector_name", "operation"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${CONNECTOR_BASE}/connector_invoke`, method: "POST" },
    executionTarget: "SERVER", tags: ["connector", "core"],
  },
  {
    name: "send_slack_message", display: "Send Slack Message", riskLevel: "medium", requiresApproval: false,
    description: "Post a message to a Slack channel via a registered SLACK connector. `connector_name` defaults to 'default-slack' when omitted.",
    inputSchema: { type: "object", properties: { connector_name: { type: "string" }, channel: { type: "string" }, text: { type: "string" }, blocks: { type: "array" } }, required: ["channel", "text"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${CONNECTOR_BASE}/send_slack_message`, method: "POST" },
    executionTarget: "SERVER", tags: ["connector", "slack", "core"],
  },
  {
    name: "send_email", display: "Send Email", riskLevel: "medium", requiresApproval: false,
    description: "Send an email via a registered EMAIL connector. `connector_name` defaults to 'default-email'.",
    inputSchema: { type: "object", properties: { connector_name: { type: "string" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, html: { type: "boolean" } }, required: ["to", "subject", "body"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${CONNECTOR_BASE}/send_email`, method: "POST" },
    executionTarget: "SERVER", tags: ["connector", "email", "core"],
  },
  {
    name: "send_teams_message", display: "Send Teams Message", riskLevel: "medium", requiresApproval: false,
    description: "Post a message to a Microsoft Teams channel via a registered TEAMS connector. `connector_name` defaults to 'default-teams'.",
    inputSchema: { type: "object", properties: { connector_name: { type: "string" }, channel: { type: "string" }, text: { type: "string" } }, required: ["channel", "text"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${CONNECTOR_BASE}/send_teams_message`, method: "POST" },
    executionTarget: "SERVER", tags: ["connector", "teams", "core"],
  },
  {
    name: "create_jira_issue", display: "Create Jira Issue", riskLevel: "medium", requiresApproval: false,
    description: "File a new Jira ticket via a registered JIRA connector. `connector_name` defaults to 'default-jira'.",
    inputSchema: { type: "object", properties: { connector_name: { type: "string" }, project: { type: "string" }, summary: { type: "string" }, description: { type: "string" }, issue_type: { type: "string" }, priority: { type: "string" }, labels: { type: "array", items: { type: "string" } } }, required: ["project", "summary"] },
    runtime: { execution_location: "server", runtime_type: "http", endpoint_url: `${CONNECTOR_BASE}/create_jira_issue`, method: "POST" },
    executionTarget: "SERVER", tags: ["connector", "jira", "core"],
  },
];

export async function seedCoreToolkit(): Promise<void> {
  let inserted = 0;
  let skipped = 0;
  for (const t of SEEDS) {
    const existing = await query(
      "SELECT id FROM tool.tools WHERE tool_name=$1 AND version=$2",
      [t.name, VERSION],
    );
    if (existing.length > 0) { skipped += 1; continue; }
    const metadata = {
      ...capabilityMetadataForTool({
        tool_name: t.name,
        metadata: {
          source: t.tags.includes("connector") ? "runtime" : "local",
          ...(t.metadata ?? {}),
        },
        runtime: t.runtime,
      }),
      ...(t.metadata ?? {}),
    };
    await query(
      `INSERT INTO tool.tools
        (tool_name, version, display_name, description, status, risk_level,
         requires_approval, input_schema, output_schema, runtime,
         allowed_capabilities, allowed_agents, tags, metadata, execution_target)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
               '[]'::jsonb,'[]'::jsonb,$10::jsonb,$11::jsonb,$12)`,
      [
        t.name, VERSION, t.display, t.description, t.riskLevel,
        t.requiresApproval,
        JSON.stringify(t.inputSchema),
        JSON.stringify(t.outputSchema ?? {}),
        JSON.stringify(t.runtime),
        JSON.stringify(t.tags),
        JSON.stringify(metadata),
        t.executionTarget,
      ],
    );
    inserted += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`[tool-service] core-toolkit seed: ${inserted} inserted, ${skipped} pre-existing`);
}
