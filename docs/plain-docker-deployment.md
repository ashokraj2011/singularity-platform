# Plain Docker Deployment

Use this path when the host has Docker but does not have, or should not use,
Docker Compose. The launcher uses only `docker build`, `docker run`,
`docker exec`, named volumes, and a shared Docker network.

MCP and LLM Gateway are not started by this script. They remain deployable
runtimes and should dial into Context Fabric separately.

## Start The Core Platform

```bash
cd /path/to/singularity-platform
bin/docker-core.sh up --build
bin/docker-core.sh seed
bin/docker-core.sh smoke
```

Open Platform Web at:

```text
http://localhost:5180
```

The default core starts:

```text
at-postgres
wg-postgres
wg-minio
iam-service
platform-core
context-api
workgraph-api
platform-web
```

It does not start:

```text
llm-gateway
mcp-server
mcp-sandbox-runner
```

## Optional Audit Governance

Audit Governance is a platform app, not an MCP/LLM runtime. Start it with:

```bash
bin/docker-core.sh up --build --with-audit
bin/docker-core.sh seed --with-audit
bin/docker-core.sh smoke --with-audit
```

This adds:

```text
audit-governance-postgres
audit-governance-service
```

## Runtime Dial-In

Start MCP and the local or remote LLM Gateway separately. For a laptop-hosted
runtime:

```bash
bin/laptop-bridge.sh gateway
bin/laptop-bridge.sh mcp
```

MCP should dial into Context Fabric at:

```text
ws://localhost:8000/api/runtime-bridge/connect
```

Check runtime registration:

```bash
curl -s http://localhost:8000/api/runtime-bridge/status | jq
```

Inside the plain Docker core, direct debug URLs default to:

```text
MCP  http://host.docker.internal:7100
LLM  http://host.docker.internal:8001
```

Normal workflow execution is still WebSocket-first through the runtime bridge.
Direct HTTP to MCP/LLM is diagnostics or explicit fallback only.

## Commands

```bash
bin/docker-core.sh build [--with-audit]
bin/docker-core.sh up [--build] [--with-audit]
bin/docker-core.sh seed [--with-audit]
bin/docker-core.sh smoke [--with-audit]
bin/docker-core.sh status
bin/docker-core.sh logs workgraph-api
bin/docker-core.sh down
bin/docker-core.sh nuke --yes
```

`down` removes containers but keeps named volumes. `nuke --yes` removes the
plain Docker data volumes.

## Notes

- The script reads `.env` and `.env.local` if present.
- It uses the same public ports as the Compose core: `5180`, `8100`, `8000`,
  `8080`, `3001-3004`, `5432`, `5434`, and `9000-9001`.
- It uses a Docker network named `singularity-core` by default. Override with
  `SINGULARITY_DOCKER_NETWORK=<name>`.
- It uses the same major container names as Compose. Stop the Compose stack
  before switching to this launcher to avoid name and port conflicts.
- The root agent-runtime SQL seed no longer writes prompt tables. Prompt
  profiles and layers are owned by Prompt Composer in `singularity_composer`.
