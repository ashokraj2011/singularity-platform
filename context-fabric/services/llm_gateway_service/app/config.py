"""M33 — LLM Gateway settings.

This service is the ONLY place provider keys are read. It also owns the
external provider config file (`.singularity/llm-providers.json`) and the
model alias catalog (`.singularity/mcp-models.json`). Every other service
calls the routes here over HTTP via `LLM_GATEWAY_URL`.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # External config paths (mounted RO at /etc/singularity in docker, or
    # ./.singularity/ in bare-metal dev).
    provider_config_path: str = "/etc/singularity/llm-providers.json"
    model_catalog_path:   str = "/etc/singularity/mcp-models.json"

    # Per-provider env-var-resolved credentials (read ONLY here).
    openai_api_key:     Optional[str] = None
    openrouter_api_key: Optional[str] = None
    anthropic_api_key:  Optional[str] = None
    copilot_token:      Optional[str] = None

    # Anthropic protocol version (no provider SDK).
    anthropic_version: str = "2023-06-01"

    # Request timeout for upstream provider calls (seconds).
    upstream_timeout_sec: int = 240

    # Service-to-service bearer accepted on this gateway. Empty disables
    # auth (development only — in production set this via IAM-minted
    # service token).
    gateway_bearer: str = ""

    # Allow caller-overrides of provider/model via the request body. When
    # false, the gateway resolves provider/model only from the configured
    # default + model_alias.
    allow_caller_provider_override: bool = True

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        env = os.environ
        # Map env vars (uppercase) -> snake_case fields, since pydantic
        # BaseSettings only honours the lowercase form by default.
        self.provider_config_path = env.get(
            "LLM_PROVIDER_CONFIG_PATH",
            env.get("MCP_LLM_PROVIDER_CONFIG_PATH", self.provider_config_path),
        )
        self.model_catalog_path = env.get(
            "LLM_MODEL_CATALOG_PATH",
            env.get("MCP_LLM_MODEL_CATALOG_PATH", self.model_catalog_path),
        )
        self.openai_api_key     = env.get("OPENAI_API_KEY")     or None
        self.openrouter_api_key = env.get("OPENROUTER_API_KEY") or None
        self.anthropic_api_key  = env.get("ANTHROPIC_API_KEY")  or None
        self.copilot_token      = env.get("COPILOT_TOKEN")      or None
        self.anthropic_version  = env.get("ANTHROPIC_VERSION", self.anthropic_version)
        self.upstream_timeout_sec = int(env.get("UPSTREAM_TIMEOUT_SEC", str(self.upstream_timeout_sec)))
        self.gateway_bearer = env.get("LLM_GATEWAY_BEARER", "")
        self.allow_caller_provider_override = (
            env.get("ALLOW_CALLER_PROVIDER_OVERRIDE", "true").lower() == "true"
        )

    def credential_for(self, provider: str) -> Optional[str]:
        p = provider.lower()
        if p in ("openai",):     return self.openai_api_key
        if p == "openrouter":    return self.openrouter_api_key
        if p == "anthropic":     return self.anthropic_api_key
        if p == "copilot":       return self.copilot_token
        if p == "mock":          return "mock"  # mock needs no key
        return None


settings = Settings()
