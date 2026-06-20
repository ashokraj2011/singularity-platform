# mcp-server — Release Notes

**Singularity Tool Runtime** (the directory and npm package are still named
`mcp-server`; it exposes an MCP-compatible interface, which is why the routes
are under `/mcp/*` and the client env vars are `MCP_*`). Tool/runtime executor.
Context Fabric owns the governed LLM loop; MCP executes tool calls, builds code
context, serves runtime resources, and handles work-branch operations. The old
HTTP loop routes (`/mcp/invoke`, `/mcp/resume`) are 410 migration shims unless
`MCP_LEGACY_INVOKE_ENABLED=true` is set for incident recovery. M44 introduced
the phased agent reasoning model (v4); M52 added the Code Context Budgeter; M60
wired the formal verifier; M64 hardened the gateway timeout/error path; M71
moved the active loop to Context Fabric.

## API surface

| Method | Path                                | Notes                                                                |
|--------|-------------------------------------|----------------------------------------------------------------------|
| GET    | `/health`                           | Liveness.                                                            |
| GET    | `/healthz/strict`                   | 503 when sandbox / AST / workitem paths are misconfigured (M28 boot-1). |
| POST   | `/mcp/invoke`                       | Deprecated 410 shim. Use Context Fabric `POST /api/v1/execute-governed-stage`; temporary recovery only with `MCP_LEGACY_INVOKE_ENABLED=true`. |
| POST   | `/mcp/resume`                       | Deprecated 410 shim. Governed stages resume by re-calling Context Fabric with persisted `PhaseState`. |
| POST   | `/mcp/code-context/build` (M52)     | Build a token-budgeted CodeContextPackage (AST slices). Called by context-fabric BEFORE prompt composition. |
| POST   | `/mcp/tools/call`                   | Direct tool invocation (operator debug).                             |
| GET    | `/mcp/tools`                        | Tool registry for the caller's bearer scope.                         |
| GET    | `/mcp/resources/read`               | Read recent audit records from the in-memory ring (LlmCall, ToolInvocation, Artifact, CodeChange). |
| POST   | `/mcp/work/finish_branch`           | Finalize a work branch (commit + optional push + formal verification gate). |

## Env vars

Selected (full list in `src/config.ts`):

| Var                              | Default                          | Notes                                                              |
|----------------------------------|----------------------------------|--------------------------------------------------------------------|
| `MCP_BEARER_TOKEN`               | (required in prod)               | Single bearer for ingress. 16+ chars, KNOWN_BAD list enforced.     |
| `MCP_SANDBOX_ROOT`               | `/workspace`                     | Container path to the operator's repo bind mount.                  |
| `MCP_AST_DB_PATH`                | (env-configurable)               | SQLite path for the AST index (M28 boot-1).                        |
| `MCP_COMMAND_EXECUTION_MODE`     | `container` (prod) / `process` (test) | Whether shell commands run in `mcp-sandbox-runner` containers.    |
| `MCP_LEGACY_INVOKE_ENABLED`      | `false`                          | Emergency-only switch that revives `/mcp/invoke` and `/mcp/resume`. |
| `TIMEOUT_SEC`                    | `300` (M64)                      | Overall agent-loop budget. Must be ≥ `LLM_GATEWAY_TIMEOUT_SEC`.    |
| `LLM_GATEWAY_URL`                | `http://llm-gateway:8001`        | Where LLM calls go.                                                |
| `LLM_GATEWAY_TIMEOUT_SEC`        | `300` (M64)                      | MUST exceed gateway's retry envelope (RETRIES × RETRY_DELAY_SEC).  |
| `FORMAL_VERIFICATION_ENABLED`    | `false`                          | When true, `finish_work_branch` calls the Z3 verifier (M60).        |
| `AGENT_RUNTIME_URL`              | empty                            | When set, fingerprint + AST-index callbacks fire (M61 Wire E, Wire B P2). |
| `MCP_WORK_BRANCH_PUSH_ON_FINISH` | `false`                          | When true, finished work branches are pushed to the configured remote. |

## Dependencies

**Upstream consumers**:
- context-fabric (`/mcp/tool-run`, `/mcp/code-context/build`, resources, and work-branch operations)
- prompt-composer (`/mcp/embeddings` via the llm-gateway, indirectly)
- direct ops (`/mcp/resources/read`, `/mcp/tools`)

**Downstream**:
- llm-gateway (every LLM call)
- mcp-sandbox-runner (containerized shell execution)
- agent-runtime (M61 callbacks: fingerprint, ast-index-built)
- audit-governance-service (every tool / llm / code change emits here)
- formal-verifier (M60, optional)
- workgraph-api (M37.1 workflow-branch operations)

## Milestones (selected — full list in commit log)

- **M9.z** — initial pending-approval gate (in-memory; M21.5 moved authority to audit-gov).
- **M14** — AST index + code symbol tools (find_symbol, get_symbol, get_ast_slice, get_dependencies).
- **M21** — fire-and-forget audit-gov emission on every llm_call / tool_invocation / code_change.
- **M28 boot-1** — `/healthz/strict` enforces sandbox + workitem + AST DB paths are configured.
- **M33** — provider keys removed; all LLM traffic via llm-gateway.
- **M36.7** — system-prompt fragments fetched from prompt-composer by key (no inline prose in source).
- **M37.1** — purpose-built workflow-branch operations (`finish_work_branch`).
- **M42.8/42.9** — MCP-native fallback tools (`find_files`, `file_stats`, `grep_lines`, `list_indexed_files`).
- **M43** — `repo_map` topology tool for grounding.
- **M44** — Phased Agent Reasoning Model v4 (PLAN_DRAFT → EXPLORE → PLAN_CONFIRM → ACT → VERIFY → FINALIZE).
- **M52** — `/mcp/code-context/build`. Returns a token-budgeted package consumed by prompt-composer.
- **M60** — formal-verifier wiring. `finish_work_branch` calls Z3 when `FORMAL_VERIFICATION_ENABLED=true`.
- **M61 Wire E + B P2** — fire-and-forget callbacks to agent-runtime on `/mcp/code-context/build`: repo fingerprint (drift detection) + AST-index built (stamps CapabilityWorldModel.astIndexedAt).
- **M63 Slice C** — `tool.filesystem.access` / `.sensitive` audit events emitted alongside `tool.invocation.completed` for filesystem tool calls.
- **M64** — `GatewayError` with structured codes (`LLM_PROVIDER_OVERLOADED`, `LLM_PROVIDER_UNAVAILABLE`, `LLM_PROVIDER_RATE_LIMITED`, `LLM_GATEWAY_TIMEOUT`, `LLM_GATEWAY_UNREACHABLE`). Replaces generic `LLM_GATEWAY_UPSTREAM` string-throws.
- **M65 Slice 1C** — local JSONL audit store documented as sandbox-debug only; audit-gov is canonical.
- **M71** — active LLM loop moved to Context Fabric governed-stage/single-turn endpoints; `/mcp/invoke` and `/mcp/resume` became 410 migration shims.

## Known limitations

- The legacy HTTP loop remains in source for emergency recovery only; normal callers should not use `/mcp/invoke` or `/mcp/resume`.
- AST index is per-container, in `MCP_AST_DB_PATH`. Re-indexing on container recreate is expensive (`prisma generate`-equivalent cost). M61's CapabilityWorldModel.astIndexedAt stamp gives observability but no automatic re-share.
- `mcp-sandbox-runner` mounts host paths verbatim — operators must keep `MCP_SANDBOX_HOST_PATH` aligned between host and container.
- The retry / structured-error work in M64 only covers the Anthropic provider in `llm-gateway`; the `openai_compat` provider has no retry logic yet.
