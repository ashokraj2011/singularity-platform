from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    llm_gateway_url: str = "http://localhost:8001"
    context_memory_url: str = "http://localhost:8002"
    metrics_ledger_url: str = "http://localhost:8003"

    # IAM federation (M6+) — used to resolve MCP server registrations per capability.
    # IAM_SERVICE_TOKEN is a long-lived admin/service JWT. In dev: paste an admin
    # login token. In prod: short-lived service token issued by IAM.
    iam_base_url: str = "http://localhost:8100/api/v1"
    iam_service_token: str = ""

    # M8 — orchestrator dependencies for /execute
    composer_url: str = "http://localhost:3004"
    tool_service_url: str = "http://localhost:3002"
    call_log_db: str = "/data/call_log.db"
    require_tenant_id: bool = False

    class Config:
        env_prefix = ""
        extra = "ignore"


settings = Settings()
