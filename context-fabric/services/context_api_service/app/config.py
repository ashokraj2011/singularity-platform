from __future__ import annotations

from pydantic_settings import BaseSettings
import os

PROD_ENVS = {"production", "prod", "staging", "perf"}
KNOWN_DEV_DEFAULTS = {
    "Admin1234!",
    "changeme",
    "changeme_dev_only_min_32_chars_long!!",
    "demo-bearer-token-must-be-min-16-chars",
    "dev-audit-gov-service-token",
    "dev-context-fabric-service-token",
    "dev-mcp-runner-token-min-16-chars",
    "dev-mcp-session-secret-min-32-chars!!",
    "dev-tool-grant-signing-secret-min-32-chars!!",
    "dev-workgraph-internal-token",
    "test-secret",
}


def _is_prod_env() -> bool:
    return any(
        os.getenv(name, "").strip().lower() in PROD_ENVS
        for name in ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV")
    )


def is_production_class_env() -> bool:
    return _is_prod_env()


def _assert_prod_secret(name: str, value: str | None, min_length: int = 32) -> None:
    if not _is_prod_env():
        return
    current = (value or "").strip()
    reasons: list[str] = []
    if not current:
        reasons.append("unset")
    elif len(current) < min_length:
        reasons.append(f"shorter than {min_length} chars (got {len(current)})")
    if current in KNOWN_DEV_DEFAULTS:
        reasons.append("matches a known development default")
    if reasons:
        raise RuntimeError(
            f"FATAL: {name} is unsafe for production-class Context Fabric: "
            f"{'; '.join(reasons)}. Set a strong random value and restart."
        )


def _assert_prod_invariant(name: str, ok: bool, message: str) -> None:
    if _is_prod_env() and not ok:
        raise RuntimeError(f"FATAL: {name} is unsafe for production-class Context Fabric: {message}")


class Settings(BaseSettings):
    context_memory_url: str = "http://localhost:8002"
    # M65 Slice 1B — metrics-ledger sunset. The legacy URL stays as a
    # config field so the deprecated /chat/respond writer (sunset
    # 2026-07-01) compiles, but no live service answers at this
    # address. New code uses audit_gov_url + the M65 Slice 1A
    # /api/v1/savings/* endpoints instead.
    metrics_ledger_url: str = "http://localhost:8003"

    # IAM federation (M6+) — used to resolve MCP server registrations per capability.
    # IAM_SERVICE_TOKEN is a long-lived admin/service JWT. In dev: paste an admin
    # login token. In prod: short-lived service token issued by IAM.
    iam_base_url: str = "http://localhost:8100/api/v1"
    iam_service_token: str = ""
    iam_service_token_tenant_ids: str = ""

    # M8 — orchestrator dependencies for /execute
    composer_url: str = "http://localhost:3004"
    tool_service_url: str = "http://localhost:3002"
    call_log_db: str = "./data/call_log.db"
    require_tenant_id: bool = False
    # SECURITY (review finding 7): deliberate escape hatch to skip /execute
    # service-token enforcement for purely-local single-tenant demos. Off by
    # default and only RELAXES non-production envs — a production-class env
    # always enforces regardless of this flag (see check_execute_service_token).
    allow_unauthenticated_dev_execute: bool = False

    # MCP execution runtime. Capabilities still scope prompts, memory, and
    # governance; the MCP server itself can be a local/default workspace
    # endpoint selected by file path or deployment config rather than by
    # capability membership.
    mcp_default_base_url: str = "http://mcp-server:7100"
    mcp_default_bearer_token: str = ""
    mcp_default_server_id: str = "default-mcp"

    # Deployment placement (see docs/deployment-topology.md). When true, an
    # enterprise LLM gateway is mandated → MCP + LLM always run in the cloud
    # (the laptop bridge is never dispatched to, even if a laptop is paired).
    enterprise_llm_gateway: bool = False

    chat_respond_model_alias: str = ""

    # M61 Wire 2 — agent-runtime base URL. context-fabric fetches the
    # capability's CapabilityWorldModel from
    #   GET ${agent_runtime_url}/capabilities/:id/world-model
    # at /execute time and passes the result through to prompt-composer
    # as ComposeInput.worldModel. Empty string disables the fetch
    # silently (older deploys with no agent-runtime peer still work —
    # they just don't get CODE_AGENT_RULES / CODE_WORLD_MODEL layers).
    agent_runtime_url: str = ""
    # Soft cap on world-model fetch latency. The default is short
    # because the fetch sits on the critical path of /execute; if
    # agent-runtime is slow we'd rather drop the layers than block
    # the whole workflow.
    agent_runtime_world_model_timeout_sec: float = 2.0

    # M65 Slice 1A/1B — audit-gov base URL. /metrics/dashboard and
    # /sessions/{id}/metrics proxy here for token-savings analytics.
    # As of Slice 1B, audit-gov is the ONLY source — those endpoints
    # return 503 when this is unset (no silent fallback to metrics-ledger,
    # which has been sunset).
    audit_gov_url: str = ""
    default_governance_mode: str = "fail_open"

    # M62 Slice E — prompt compression toggle for compose calls.
    # When enabled, the compose request body carries a `compression`
    # block that tells prompt-composer to POST over-budget allowlisted
    # layers to the prompt-compressor sidecar. Default OFF — operator
    # flips COMPRESSION_ENABLED=true in .env after observing the
    # stack behaves correctly on the new layers.
    compressor_url: str = ""
    compression_enabled: bool = False
    compression_per_layer_budget_tokens: int = 1500

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.mcp_default_base_url = os.getenv("MCP_SERVER_URL", self.mcp_default_base_url)
        self.mcp_default_bearer_token = os.getenv("MCP_BEARER_TOKEN", self.mcp_default_bearer_token)
        # M61 Wire 2 — same env-fallback pattern as the MCP block above.
        self.agent_runtime_url = os.getenv("AGENT_RUNTIME_URL", self.agent_runtime_url)
        # M62 Slice E
        self.compressor_url = os.getenv("COMPRESSOR_URL", self.compressor_url)
        # M65 Slice 1A
        self.audit_gov_url = os.getenv("AUDIT_GOV_URL", self.audit_gov_url)


settings = Settings()

_assert_prod_secret("JWT_SECRET", os.getenv("JWT_SECRET"))
_assert_prod_secret("IAM_SERVICE_TOKEN", settings.iam_service_token)
_assert_prod_invariant(
    "IAM_SERVICE_TOKEN_TENANT_IDS",
    (not settings.require_tenant_id) or bool((settings.iam_service_token_tenant_ids or "").strip()),
    "set IAM_SERVICE_TOKEN_TENANT_IDS to the tenant ids this service token may access",
)
_assert_prod_secret("MCP_BEARER_TOKEN", settings.mcp_default_bearer_token)
_assert_prod_secret("AUDIT_GOV_SERVICE_TOKEN", os.getenv("AUDIT_GOV_SERVICE_TOKEN"))
_assert_prod_invariant(
    "DEFAULT_GOVERNANCE_MODE",
    settings.default_governance_mode.strip().lower() == "fail_closed",
    "set DEFAULT_GOVERNANCE_MODE=fail_closed so omitted run governance cannot default to fail-open",
)
_cf_tool_grant_enabled = os.getenv("CF_TOOL_GRANT_ENABLED", "").strip().lower() in {"true", "1", "yes", "on"}
_assert_prod_invariant(
    "CF_TOOL_GRANT_ENABLED",
    _cf_tool_grant_enabled,
    "set CF_TOOL_GRANT_ENABLED=true so MCP can verify Context Fabric-issued grants for mutating tools",
)
if _cf_tool_grant_enabled:
    _assert_prod_secret("TOOL_GRANT_SIGNING_SECRET", os.getenv("TOOL_GRANT_SIGNING_SECRET"))
_assert_prod_invariant(
    "REQUIRE_TENANT_ID",
    settings.require_tenant_id,
    "set REQUIRE_TENANT_ID=true so calls cannot omit tenant scope",
)
