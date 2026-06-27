# Office Hybrid Deployment Config Plan

## Summary

This guide describes the office deployment shape where the laptop owns local AI and code execution, while AWS owns the platform services and durable state.

Run only these on the office laptop:

- Copilot headless or an OpenAI-compatible Copilot adapter.
- Singularity LLM Gateway.
- Agent Execution Runtime, currently `mcp-server`.
- Optional sandbox runner for local command and test execution.

Run everything else in AWS containers:

- Workgraph API.
- Platform Web (the single frontend — operations, agents, workflows, workbench, foundry, identity, all same-origin).
- Context Fabric.
- Prompt Composer.
- Agent Runtime and Agent Service (Agent Service now serves both agents **and** tools — the former Tool Service is merged in).
- IAM.
- Audit and governance services.
- Databases.

In the preferred office topology, the laptop runtime connects outbound to AWS Context Fabric through the laptop bridge WebSocket. AWS does not need an inbound URL to the laptop runtime in that mode.

Direct AWS-to-laptop HTTP is still useful as a fallback or non-bridge deployment, but it requires exposing a private laptop runtime URL.

## Network Contract

### Preferred: WebSocket Bridge

Use one AWS bridge endpoint reachable from the laptop:

```bash
AWS_CONTEXT_FABRIC_URL=https://<aws-context-api-url>
LAPTOP_BRIDGE_URL=wss://<aws-context-api-url>/api/laptop-bridge/connect
```

Recommended connectivity:

- Laptop opens the outbound WebSocket to AWS.
- AWS sends `invoke` or `tool-run` frames back over the same socket.
- No inbound laptop port is required for Agent Execution Runtime.
- Do not expose the Copilot headless port `4222` directly.
- Use IAM device tokens for laptop bridge authentication.

### Optional Fallback: Direct HTTP

Use these only if you intentionally want AWS services to call the laptop runtime over HTTP:

```bash
LAPTOP_MCP_URL=https://<private-laptop-runtime-url>
LAPTOP_LLM_GATEWAY_URL=https://<private-laptop-gateway-url>
```

Recommended direct-HTTP connectivity:

- Tailscale, corporate VPN, Cloudflare Tunnel, or reverse tunnel from the laptop to AWS.
- Allow AWS to reach only the laptop runtime port `7100` and, if needed, the laptop gateway port `8001`.
- Do not expose the Copilot headless port `4222` directly.
- Use TLS and strong bearer tokens.

## Laptop Configuration

Run Copilot headless, or the office Copilot adapter, on the laptop and verify it is OpenAI-compatible:

```bash
curl http://127.0.0.1:4222/v1/models
```

Run the LLM Gateway on the laptop and point it to Copilot:

```bash
bin/llm-use-copilot.sh \
  --base-url http://host.docker.internal:4222/v1 \
  --model gpt-4o \
  --token copilot-local
```

Use `http://127.0.0.1:4222/v1` instead if the gateway runs directly on the host instead of Docker.

Laptop `mcp-server/.env` should contain:

```bash
PORT=7100
MCP_BEARER_TOKEN=<strong-shared-runtime-token>

LLM_GATEWAY_URL=http://localhost:8001
LLM_GATEWAY_BEARER=<optional-gateway-bearer>
LLM_GATEWAY_TIMEOUT_SEC=300

MCP_SANDBOX_ROOT=/path/to/local/workspace
MCP_WORKITEM_WORKSPACES_ROOT=/path/to/local/workspace/.singularity/workitems
MCP_COMMAND_EXECUTION_MODE=container
MCP_RUNNER_URL=http://localhost:7110
MCP_RUNNER_TOKEN=<strong-runner-token>

MCP_GIT_PUSH_ENABLED=true
MCP_GIT_AUTH_MODE=token
MCP_GIT_TOKEN_ENV=GITHUB_TOKEN
GITHUB_TOKEN=<office-approved-github-token>

CONTEXT_FABRIC_URL=https://<aws-context-api-url>
AGENT_RUNTIME_URL=https://<aws-agent-runtime-url>
```

For bridge mode, the laptop runtime also needs:

```bash
LAPTOP_MODE=true
LAPTOP_BRIDGE_URL=wss://<aws-context-api-url>/api/laptop-bridge/connect
SINGULARITY_IAM_URL=https://<aws-iam-url>/api/v1
```

Start the local laptop pieces:

```bash
COMPOSE_PROFILES=gateway-only docker compose up -d llm-gateway
docker compose up -d mcp-sandbox-runner
cd mcp-server && npm run build
npm run dev:cli -- login --platform https://<aws-iam-url>/api/v1 --email <you@company.com>
npm run dev:cli -- start --bridge wss://<aws-context-api-url>/api/laptop-bridge/connect
```

## AWS Configuration

### Preferred Bridge Mode

In bridge mode, keep the platform-side MCP URL pointed at a small shared/default runtime only as a fallback, but route Workbench/agent stages through the laptop bridge by setting `prefer_laptop=true` for the stage/run.

Context Fabric already exposes:

```text
GET /api/laptop-bridge/status
WS  /api/laptop-bridge/connect
```

When a live laptop is connected for the run's user and `prefer_laptop=true`, Context Fabric dispatches `invoke` or `tool-run` frames over the WebSocket. If `prefer_laptop=true` and no laptop is connected, the run fails fast with `MCP_NOT_CONNECTED`.

AWS services still need normal internal service URLs for Workgraph, Context Fabric, Prompt Composer, IAM, Agent Runtime, and audit/governance. They do not need `LAPTOP_MCP_URL` in bridge mode.

### Direct HTTP Fallback

If you do not use the bridge, every AWS service that currently points at `http://mcp-server:7100` must point at the laptop URL.

Set these in the AWS environment or compose override:

```bash
MCP_SERVER_URL=${LAPTOP_MCP_URL}
MCP_DEFAULT_BASE_URL=${LAPTOP_MCP_URL}
MCP_PUBLIC_BASE_URL=${LAPTOP_MCP_URL}
MCP_BEARER_TOKEN=<same-strong-runtime-token>
MCP_DEFAULT_BEARER_TOKEN=<same-strong-runtime-token>
MCP_DEMO_BEARER_TOKEN=<same-strong-runtime-token>

LLM_GATEWAY_URL=${LAPTOP_LLM_GATEWAY_URL}
LLM_GATEWAY_BEARER=<optional-gateway-bearer>
```

Apply these direct-HTTP values to:

- `context-api`
- `workgraph-api`
- `agent-service` (now serves both agents **and** tools — the former `tool-service` is merged in; there is no separate `tool-service` or `:3002`)
- `agent-runtime`
- `prompt-composer`
- `platform-web`
- optional `context-memory`, only if it still runs

Important: the current `docker-compose.yml` hardcodes several internal URLs, so root `.env` alone is not enough for direct HTTP. For AWS, use a compose override or ECS/Kubernetes environment injection to replace those values.

## AWS Compose Override Shape

Use this only for direct HTTP mode:

```yaml
services:
  context-api:
    environment:
      MCP_SERVER_URL: ${LAPTOP_MCP_URL}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}
      MCP_DEFAULT_BASE_URL: ${LAPTOP_MCP_URL}
      MCP_DEFAULT_BEARER_TOKEN: ${MCP_BEARER_TOKEN}
      LLM_GATEWAY_URL: ${LAPTOP_LLM_GATEWAY_URL}

  workgraph-api:
    environment:
      MCP_SERVER_URL: ${LAPTOP_MCP_URL}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}

  # agent-service now serves both agents AND tools (the former tool-service is
  # merged in — no separate tool-service / :3002; TOOL_SERVICE_URL -> agent-service:3001).
  agent-service:
    environment:
      MCP_SERVER_URL: ${LAPTOP_MCP_URL}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}

  agent-runtime:
    environment:
      MCP_SERVER_URL: ${LAPTOP_MCP_URL}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}

  prompt-composer:
    environment:
      MCP_SERVER_URL: ${LAPTOP_MCP_URL}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN}
```

Cleanest bridge target: AWS keeps Context Fabric's laptop bridge enabled and does not require inbound access to the laptop runtime. If compose dependencies force an AWS `mcp-server` to start, treat it as a fallback/default runtime until a dedicated `aws-office-bridge` profile removes that dependency.

## Verification

From the laptop:

```bash
curl http://127.0.0.1:4222/v1/models
curl http://127.0.0.1:8001/llm/providers
curl -H "authorization: Bearer <runtime-token>" http://127.0.0.1:7100/healthz/strict
```

For bridge mode, verify AWS sees the laptop:

```bash
curl https://<aws-context-api-url>/api/laptop-bridge/status
```

For direct HTTP mode, verify from an AWS container:

```bash
curl -H "authorization: Bearer <runtime-token>" ${LAPTOP_MCP_URL}/healthz/strict
curl ${LAPTOP_LLM_GATEWAY_URL}/llm/providers
```

Then run a Workbench stage and confirm:

- Context Fabric dispatches to the laptop Agent Execution Runtime over the bridge, or over direct HTTP if that fallback mode is selected.
- Agent Execution Runtime calls the laptop LLM Gateway.
- LLM Gateway calls laptop Copilot headless.
- Code checkout, tests, git auth, and push all happen on the laptop.
- AWS services store WorkItems, workflow state, audit, prompts, evidence, and approvals.

## Assumptions

- Office policy allows Copilot traffic only from the laptop.
- AWS can reach the laptop through a private tunnel or VPN.
- Copilot headless exposes OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints.
- Provider credentials stay only on the laptop.
- Git credentials stay only on the laptop.
