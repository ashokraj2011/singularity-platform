# prompt-composer — Release Notes

DB-backed prompt assembly layer. Composes per-stage system prompts from
prioritized layer fragments (PLATFORM_CONSTITUTION, AGENT_ROLE,
CAPABILITY_CONTEXT, …, CODE_* slices, OUTPUT_CONTRACT, TASK_CONTEXT).
M52 added the Code Context Budgeter; M61 added CapabilityWorldModel
layers; M62 added per-layer prompt compression.

## API surface

| Method | Path                              | Notes                                                              |
|--------|-----------------------------------|--------------------------------------------------------------------|
| GET    | `/health`                         | Liveness.                                                          |
| POST   | `/api/v1/compose-and-respond`     | Primary entry. Composes the prompt, hits MCP, returns assembled prompt + final response. `previewOnly=true` returns the prompt without LLM. |
| POST   | `/api/v1/assemble/preview`        | Compose without LLM round-trip (operator debug).                   |
| POST   | `/api/v1/capsule/compile`         | Compile a CapabilityCompiledContext capsule (M25.5).               |
| GET    | `/api/v1/profiles/:id`            | PromptProfile read.                                                |
| POST   | `/api/v1/profiles`                | Mutate prompt profiles + layer assignments.                        |

## Env vars

| Var                              | Default                                              | Notes                                                              |
|----------------------------------|------------------------------------------------------|--------------------------------------------------------------------|
| `DATABASE_URL`                   | (required)                                           | `singularity_composer` Postgres. Owns PromptProfile / Layer / Assembly / Capsule. |
| `DATABASE_URL_RUNTIME_READ`      | (required)                                           | Reader connection to `singularity` (agent-runtime's DB) for AgentTemplate / Capability lookups. |
| `MCP_SERVER_URL`                 | `http://mcp-server:7100`                        | Where to send composed prompts.                                    |
| `MCP_BEARER_TOKEN`               | (required when MCP requires auth)                    | Same `dev-…-16-chars` default as the rest of the stack.            |
| `COMPRESSOR_URL` (M62)           | empty                                                | Prompt-compressor sidecar. When set + `compression.enabled` in the request, over-budget allowlisted layers get compressed in place. |
| `JWT_SECRET`                     | (required)                                           | Shared secret for IAM-authed routes.                               |

## Dependencies

**Upstream consumers**:
- context-fabric (via `/api/v1/compose-and-respond` on every `/execute` for workflow stages)
- agent-and-tools/web admin (PromptProfile CRUD UI)

**Downstream**:
- mcp-server (LLM execution path)
- agent-runtime DB (PromptProfile reads via `runtimeReader`)
- prompt-compressor (M62, optional)
- llm-gateway (embedding for capsule semantic retrieval — M25.5)

## Milestones

- **M14** — initial composer with CODE_CONTEXT (semantic-retrieval) layer.
- **M25.5** — capsule cache (CapabilityCompiledContext) so repeated identical requests skip re-assembly.
- **M30** — owns its own `singularity_composer` DB; reads agent-runtime via a separate `runtimeReader` client.
- **M36.7** — mcp-server fetches the "code-tool-use nudge" SystemPrompt by key instead of hardcoding it in mcp source.
- **M44 Slice C** — `compactToolContracts` flag to drop redundant JSON schemas from the TOOL_CONTRACT layer when callers route tools via the provider's structured channel.
- **M52** — Code Context Budgeter. Emits 7 deterministic CODE_* layers from a pre-built `codeContextPackage` (TASK_INTENT, TARGET_SYMBOLS, EDITABLE_SLICES, DEPENDENCY_SLICES, TYPE_CONTRACTS, TEST_SLICES, CONTEXT_RECEIPT) in place of the legacy CODE_CONTEXT layer.
- **M61 Slice F** — CODE_AGENT_RULES (priority 305) + CODE_WORLD_MODEL (priority 308) layers above the M52 CODE_* layers. Renders CLAUDE.md / AGENTS.md verbatim and the capability's test commands / README summary / architecture slice.
- **M62 Slice D** — Per-layer prompt compression. When `ComposeInput.compression.enabled` is true, over-budget allowlisted layers are sent to the prompt-compressor sidecar and the compressed text replaces the contentSnapshot in place. Default allowlist: CODE_AGENT_RULES + RUNTIME_EVIDENCE.

## Known limitations

- Capsule cache key doesn't include the M62 compression block, so compression-on/off requires `bypassCache=true` during testing.
- The 7 M52 CODE_* layers are EITHER emitted (when `codeContextPackage` is passed) OR fall back to the legacy CODE_CONTEXT. There's no per-layer mix-and-match.
- The CodeContext schema mirrors mcp-server's `CodeContextPackage` interface — drift between the two would silently fail validation. Pinned in `code-context-layers.contract.test.ts` but no static check enforces equivalence.
