# Agent Execution Runtime Discovery Endpoint

Every Singularity Agent Execution Runtime host should expose the same discovery route:

```text
GET /mcp/discovery
Authorization: Bearer <MCP_BEARER_TOKEN>
```

The `/mcp/discovery` path and `MCP_BEARER_TOKEN` environment name are legacy
compatibility names. The product/component name is **Agent Execution Runtime**.

The response is a JSON envelope:

```json
{
  "success": true,
  "data": {
    "kind": "singularity.runtime.discovery",
    "schema": "https://singularity.local/schemas/runtime-discovery/v1",
    "schemaVersion": "1.0.0",
    "server": {},
    "capabilities": {},
    "endpoints": [],
    "tools": [],
    "resources": {},
    "events": {},
    "models": {},
    "schemas": {}
  },
  "requestId": "..."
}
```

## Required Fields

- `kind`: must be `singularity.runtime.discovery`
- `schemaVersion`: discovery contract version
- `server`: service identity, base URL, auth mode, default model/provider
- `capabilities`: booleans for supported runtime features
- `endpoints`: machine-readable HTTP/WebSocket endpoints
- `tools`: local tool descriptors with JSON input/output schemas
- `resources`: resource kinds exposed by `/mcp/resources/*`
- `events`: polling/replay/WebSocket event stream details
- `models`: model/provider discovery paths and default alias
- `schemas`: JSON Schemas for common request and descriptor shapes

## Tool Descriptor Shape

Each tool entry uses this shape:

```json
{
  "name": "apply_patch",
  "description": "Apply a unified diff patch inside the runtime sandbox.",
  "natural_language": "Use this when ...",
  "input_schema": {},
  "output_schema": {},
  "risk_level": "MEDIUM",
  "requires_approval": false,
  "execution_target": "LOCAL",
  "tags": ["code", "mutating"]
}
```

## Example

```bash
curl -sS http://localhost:7100/mcp/discovery \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN"
```

External apps should call this endpoint first, cache it briefly, and then use
the returned `endpoints`, `tools`, and `schemas` instead of hard-coding runtime
capabilities.
