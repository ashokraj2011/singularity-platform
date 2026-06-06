# llm-gateway-service — Release Notes

The single service in the platform that holds upstream provider API keys
(Anthropic / OpenAI / OpenAI-compat / Copilot). Every other service
routes LLM traffic through `POST /v1/chat/completions` here. M64
hardened the retry envelope + error taxonomy after a production
Anthropic 529 incident.

## API surface

| Method | Path                       | Notes                                                          |
|--------|----------------------------|----------------------------------------------------------------|
| GET    | `/health`                  | Liveness probe.                                                |
| GET    | `/healthz/strict`          | Returns 503 when provider configs are unparseable or unreachable. |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat. Validates against the model catalog. Routes to the provider behind the requested `model_alias`. |
| POST   | `/v1/embeddings`           | Embeddings for the configured embedding model alias.           |
| GET    | `/v1/models`               | Lists model aliases visible to the caller (from `LLM_MODEL_CATALOG_PATH`). |

Request validation rejects callers attempting `provider` overrides when
`ALLOW_CALLER_PROVIDER_OVERRIDE=false` (the production default).

## Env vars

| Var                                       | Default                                                | Notes                                                       |
|-------------------------------------------|--------------------------------------------------------|-------------------------------------------------------------|
| `LLM_PROVIDER_CONFIG_PATH`                | `/etc/singularity/llm-providers.json`                  | Provider config (base URLs, API key references).            |
| `LLM_MODEL_CATALOG_PATH`                  | `/etc/singularity/llm-models.json`                     | Alias → (provider, model, pricing) map.                      |
| `LLM_GATEWAY_BEARER`                      | empty                                                  | When set, every caller must `Authorization: Bearer …`.       |
| `ALLOW_CALLER_PROVIDER_OVERRIDE`          | `false`                                                | When true, callers can bypass `model_alias` (dev only).      |
| `UPSTREAM_TIMEOUT_SEC`                    | `300` (M64)                                            | Wait on the upstream provider before aborting.               |
| `LLM_GATEWAY_RATE_LIMIT_RETRIES`          | `2` (M64)                                              | Retries for retryable upstream statuses (429/503/529).       |
| `LLM_GATEWAY_RATE_LIMIT_RETRY_DELAY_SEC`  | `65`                                                   | Floor on retry delay (Retry-After honored when present).     |
| `LLM_GATEWAY_RATE_LIMIT_MAX_SLEEP_SEC`    | `75`                                                   | Cap on retry delay.                                          |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …  | empty                                                  | Loaded via `env_file: .env.llm-secrets` (M53).               |

`env_file: .env.llm-secrets` (separate from `.env`, gitignored) is the
ONLY supported way to deliver provider keys. Shell-substitution paths
(`${ANTHROPIC_API_KEY}`) were removed in M53 because empty operator-
shell env vars were silently zeroing keys during `docker compose up`.

## Dependencies

**Upstream consumers** (services that call the gateway):
- mcp-server (`/v1/chat/completions` for every LLM turn)
- prompt-composer (`/v1/embeddings` for capsule retrieval)

**Downstream providers** (the gateway calls these):
- Anthropic, OpenAI, OpenAI-compatible (Azure / OpenRouter / local), Copilot
- Internal `mock` provider for tests

The gateway has no DB dependency.

## Milestones (M-numbered breaking-change history)

- **M33** — initial release. Centralized the platform's API key handling so no other service holds provider creds.
- **M33.7** — CI guard that rejects provider env vars on any service other than llm-gateway.
- **M53** — switched from `${VAR:-}` shell substitution to `env_file: .env.llm-secrets` because empty operator-shell env vars were shadowing real values during `--force-recreate`.
- **M64** — retry envelope expanded from `{429}` to `{429, 503, 529}`. Default `LLM_GATEWAY_RATE_LIMIT_RETRIES` bumped 1 → 2. `UPSTREAM_TIMEOUT_SEC` bumped 240 → 300 so MCP's wait exceeds the retry envelope (was 2 × 65 = 130s). Anthropic 529 → 502 wrapping is detected and re-classified for consumers.

## Known limitations

- `openai_compat` provider has no retry logic of its own — only the Anthropic provider implements the M64 retry set. Adding the same logic to `openai_compat.py` is tracked as a follow-up.
- The model catalog is loaded at startup, not hot-reloaded. Changes to `llm-models.json` require a container restart.
- No per-caller rate limit at the gateway layer. Rate limiting happens upstream-side (provider quotas) and downstream-side (audit-gov budgets).
