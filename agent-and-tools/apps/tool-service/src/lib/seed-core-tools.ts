/**
 * M18 — core-toolkit seeder.
 *
 * Registers the 10 always-on tools in `tool.tools` on tool-service startup.
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

const VERSION = "1.0.0";
const INTERNAL_BASE = process.env.INTERNAL_TOOLS_BASE_URL ?? "http://tool-service:3002/api/v1/internal-tools";

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
    description: "Create or overwrite a file under the MCP sandbox root.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "write_file" },
    executionTarget: "LOCAL", tags: ["fs", "code", "core"],
  },
  {
    name: "git_commit", display: "Git Commit", riskLevel: "medium", requiresApproval: false,
    description: "Stage all dirty files under the sandbox and commit with the given message.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, author: { type: "string" } }, required: ["message"] },
    runtime: { execution_location: "client_local_runner", runtime_type: "mcp", tool_name: "git_commit" },
    executionTarget: "LOCAL", tags: ["git", "code", "core"],
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
    description: "Summarise an arbitrary piece of text into a single concise paragraph using the configured LLM gateway.",
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
    await query(
      `INSERT INTO tool.tools
        (tool_name, version, display_name, description, status, risk_level,
         requires_approval, input_schema, output_schema, runtime,
         allowed_capabilities, allowed_agents, tags, metadata, execution_target)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
               '[]'::jsonb,'[]'::jsonb,$10::jsonb,'{}'::jsonb,$11)`,
      [
        t.name, VERSION, t.display, t.description, t.riskLevel,
        t.requiresApproval,
        JSON.stringify(t.inputSchema),
        JSON.stringify(t.outputSchema ?? {}),
        JSON.stringify(t.runtime),
        JSON.stringify(t.tags),
        t.executionTarget,
      ],
    );
    inserted += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`[tool-service] core-toolkit seed: ${inserted} inserted, ${skipped} pre-existing`);
}
