# Context Fabric

Context Fabric is a standalone LLM context optimization platform. It sits between applications/agents and LLMs, keeps session context outside the model, summarizes long conversations, compiles optimized context packages, calls model providers through a gateway, and records raw-vs-optimized token savings.

## What is included

This MVP contains four independent FastAPI services:

1. **context-api-service** — public API for clients. Orchestrates memory, context compile, LLM calls, and metrics.
2. **llm-gateway-service** — model gateway for mock, OpenRouter/OpenAI-compatible, OpenAI-compatible custom endpoints, and Ollama.
3. **context-memory-service** — conversation storage, summaries, memories, and context compiler.
4. **metrics-ledger-service** — token-savings and cost-savings ledger.

It also includes a small Python SDK and smoke test.

## Quick start with Docker Compose

```bash
cp .env.example .env
# Optional: edit OPENROUTER_API_KEY or OLLAMA_BASE_URL in .env

docker compose up --build
```

Open docs:

- Context API: http://localhost:8000/docs
- LLM Gateway: http://localhost:8001/docs
- Context Memory: http://localhost:8002/docs
- Metrics Ledger: http://localhost:8003/docs

## First call using mock model

```bash
curl -s http://localhost:8000/chat/respond \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id":"demo-session",
    "agent_id":"developer-agent",
    "message":"Design the first version of Context Fabric backend.",
    "provider":"mock",
    "model":"mock-fast",
    "context_policy":{"optimization_mode":"medium","compare_with_raw":true,"max_context_tokens":12000}
  }' | jq
```

Send multiple calls to the same `session_id`; summaries and optimized context become more useful as the session grows.

## OpenRouter example

Set `OPENROUTER_API_KEY` in `.env`, then call:

```bash
curl -s http://localhost:8000/chat/respond \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id":"openrouter-demo",
    "agent_id":"architect-agent",
    "message":"Summarize our architecture decisions and continue the design.",
    "provider":"openrouter",
    "model":"openai/gpt-4o-mini",
    "context_policy":{"optimization_mode":"medium","compare_with_raw":true,"max_context_tokens":16000}
  }' | jq
```

## Ollama example

Start Ollama locally and expose it to Docker, or run the services directly on your machine. Then call:

```json
{
  "provider": "ollama",
  "model": "qwen2.5-coder:7b"
}
```

By default, `OLLAMA_BASE_URL=http://host.docker.internal:11434` in Docker Compose.

## Core API

### POST `/chat/respond`

This is the main product API.

It:

1. Saves the user message.
2. Optionally refreshes the rolling summary.
3. Builds raw context.
4. Builds optimized context.
5. Calls the LLM Gateway.
6. Saves assistant response.
7. Records token savings in the metrics ledger.
8. Returns response + savings receipt.

Example response:

```json
{
  "response": "...",
  "session_id": "demo-session",
  "context_package_id": "...",
  "model_call_id": "...",
  "optimization": {
    "mode": "medium",
    "raw_input_tokens": 52000,
    "optimized_input_tokens": 8400,
    "tokens_saved": 43600,
    "percent_saved": 83.84,
    "estimated_cost_saved": 0.21
  }
}
```

### POST `/context/compare`

Compares context modes without calling an LLM.

```bash
curl -s http://localhost:8000/context/compare \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id":"demo-session",
    "agent_id":"developer-agent",
    "message":"Continue the implementation",
    "modes":["none","conservative","medium","aggressive"],
    "max_context_tokens":16000
  }' | jq
```

## Service ports

| Service | Port |
|---|---:|
| context-api-service | 8000 |
| llm-gateway-service | 8001 |
| context-memory-service | 8002 |
| metrics-ledger-service | 8003 |

## Local development without Docker

From repo root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

export PYTHONPATH=$PWD:$PWD/shared

uvicorn services.llm_gateway_service.app.main:app --port 8001 --reload
uvicorn services.context_memory_service.app.main:app --port 8002 --reload
uvicorn services.metrics_ledger_service.app.main:app --port 8003 --reload
uvicorn services.context_api_service.app.main:app --port 8000 --reload
```

## Design notes

- SQLite is used by default for easy local testing.
- Each service owns its own SQLite DB file under `./data`.
- The services are independent; later you can move each to PostgreSQL with minimal changes.
- Token counting uses `tiktoken` if available, otherwise a conservative approximation.
- Summarization uses the LLM Gateway if configured, but falls back to an extractive structured summary if the summarizer model is unavailable.

## Next upgrades

1. Replace SQLite with PostgreSQL schemas.
2. Add pgvector for semantic memory retrieval.
3. Add agent-wise context profiles and self-tuning policy learner.
4. Add quality evaluation and missing-context detection.
5. Add code-aware context slicing for developer agents.
6. Add signed receipts/hash-chain ledger.
