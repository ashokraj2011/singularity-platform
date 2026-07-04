# Runtime Dial-In Fabric

Context Fabric is the server-side orchestration point. MCP runtimes connect to
it outbound over WebSocket, so they can run in Docker, on a server, or on a
developer laptop without exposing inbound ports.

## Normal Path

1. IAM mints a runtime/device token.
2. MCP starts with `RUNTIME_DIAL_IN_MODE=true`.
3. MCP connects to `WS /api/runtime-bridge/connect`.
4. MCP sends `hello` with runtime identity, tenant/user, supported frames,
   capability tags, and local health metadata.
5. Context Fabric routes `tool-run`, `model-run`, and `code-context` frames to
   the selected connected runtime.
6. MCP handles `model-run` by forwarding the request to its local or colocated
   `LLM_GATEWAY_URL`.

`/api/laptop-bridge/connect` remains as a compatibility alias for old clients.

After authentication, Context Fabric replies with `auth.ack`. MCP treats
`max_concurrent_invokes` as advisory but bounded: values above 32 are rejected
by the runtime bridge frame contract, so a bad bridge setting cannot make one
runtime accept unbounded parallel tool/model work.

## Routing

Context Fabric chooses runtimes in this order:

1. User-owned connected runtime for the run user.
2. Tenant/shared connected runtime.
3. Direct HTTP fallback only when `RUNTIME_HTTP_FALLBACK_ENABLED=true`.

Capability tags narrow eligible runtimes. They do not override user/tenant
placement.

## Key Environment

Runtime host:

```bash
export RUNTIME_DIAL_IN_MODE=true
export RUNTIME_BRIDGE_URL=ws://<context-fabric-host>:8000/api/runtime-bridge/connect
export SINGULARITY_RUNTIME_TOKEN=<iam-runtime-token>
export SINGULARITY_RUNTIME_ID=<stable-runtime-id>
export SINGULARITY_RUNTIME_TYPE=mcp
export SINGULARITY_TENANT_ID=<tenant-id>
export SINGULARITY_USER_ID=<user-id>
export LLM_GATEWAY_URL=http://localhost:8001
```

Context Fabric:

```bash
export RUNTIME_HTTP_FALLBACK_ENABLED=false
```

Set `RUNTIME_HTTP_FALLBACK_ENABLED=true` only for direct-HTTP debug overlays or
temporary compatibility testing. With the default `false`, tool/model/code
context dispatch, branch finalization, and worktree file writes fail closed when
no eligible Runtime Bridge MCP runtime is connected.

## Status

Use:

```bash
source .env.local
curl -s -H "X-Service-Token: $CONTEXT_FABRIC_SERVICE_TOKEN" http://localhost:8000/api/runtime-bridge/status | jq
```

The response includes connected runtimes, tenant/user grouping, supported
frames, capability tags, health metadata, and last heartbeat. The legacy
`/api/laptop-bridge/status` endpoint returns the same data during migration.
Runtime status is a protected control-plane read by default; use `/health` for
unauthenticated liveness only.
