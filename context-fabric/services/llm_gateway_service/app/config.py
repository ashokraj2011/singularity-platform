"""M33 — LLM Gateway settings.

This service is the ONLY place provider keys are read. It also owns the
external provider config file (`.singularity/llm-providers.json`) and the
model alias catalog (`.singularity/llm-models.json`, formerly `mcp-models.json`
— a back-compat fallback to the old name remains in provider_config). Every
other service calls the routes here over HTTP via `LLM_GATEWAY_URL`.
"""
from __future__ import annotations

import os
import sys
from typing import Mapping, Optional

from pydantic_settings import BaseSettings


DEFAULT_UPSTREAM_TIMEOUT_SEC = 240
DEFAULT_RATE_LIMIT_RETRIES = 2
DEFAULT_RATE_LIMIT_RETRY_DELAY_SEC = 65.0
DEFAULT_RATE_LIMIT_MAX_SLEEP_SEC = 75.0


def _warn_config(name: str, raw: str, value: int | float, reason: str) -> None:
    print(
        f"[llm-gateway] WARNING: ignoring {name}={raw!r}; using {value!r} ({reason})",
        file=sys.stderr,
    )


def _bounded_int_env(
    env: Mapping[str, str],
    name: str,
    default: int,
    *,
    min_value: int,
    max_value: int,
) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        _warn_config(name, raw, default, "expected integer")
        return default
    if value < min_value:
        _warn_config(name, raw, default, f"minimum is {min_value}")
        return default
    if value > max_value:
        _warn_config(name, raw, max_value, f"maximum is {max_value}")
        return max_value
    return value


def _bounded_float_env(
    env: Mapping[str, str],
    name: str,
    default: float,
    *,
    min_value: float,
    max_value: float,
) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        _warn_config(name, raw, default, "expected number")
        return default
    if value < min_value:
        _warn_config(name, raw, default, f"minimum is {min_value}")
        return default
    if value > max_value:
        _warn_config(name, raw, max_value, f"maximum is {max_value}")
        return max_value
    return value


class Settings(BaseSettings):
    # External config paths (mounted RO at /etc/singularity in docker, or
    # ./.singularity/ in bare-metal dev).
    provider_config_path: str = "/etc/singularity/llm-providers.json"
    model_catalog_path:   str = "/etc/singularity/llm-models.json"

    # Per-provider env-var-resolved credentials (read ONLY here).
    openai_api_key:     Optional[str] = None
    openrouter_api_key: Optional[str] = None
    anthropic_api_key:  Optional[str] = None

    # Anthropic protocol version (no provider SDK).
    anthropic_version: str = "2023-06-01"

    # ADR 0003 — Anthropic prompt-caching beta header value. Sent only when a
    # request carries prompt_cache.enabled. Pinned here (like anthropic_version)
    # so the beta token can be bumped via env without a code change.
    anthropic_prompt_cache_beta: str = "prompt-caching-2024-07-31"
    # Global kill switch for server-level prompt caching. When false, the
    # gateway ignores prompt_cache directives entirely (no cache_control, no
    # beta header) — a fast rollback path if a provider misbehaves.
    prompt_cache_enabled: bool = True

    # Request timeout for upstream provider calls (seconds).
    upstream_timeout_sec: int = DEFAULT_UPSTREAM_TIMEOUT_SEC

    # Upstream provider transient-failure handling. Retries fire for
    # 429 (rate limit), 503 (upstream down), and 529 (Anthropic
    # overloaded_error). Default 2 retries (3 total attempts) cleanly
    # absorbs ~2 min of upstream wobble; pure latency on healthy calls
    # is unchanged since no retries fire when status==200.
    upstream_rate_limit_retries: int = DEFAULT_RATE_LIMIT_RETRIES
    upstream_rate_limit_retry_delay_sec: float = DEFAULT_RATE_LIMIT_RETRY_DELAY_SEC
    upstream_rate_limit_max_sleep_sec: float = DEFAULT_RATE_LIMIT_MAX_SLEEP_SEC

    # Service-to-service bearer accepted on this gateway. Empty disables
    # auth (development only — in production set this via IAM-minted
    # service token).
    gateway_bearer: str = ""

    # Allow caller-overrides of provider/model via the request body. When
    # false, the gateway resolves provider/model only from the configured
    # default + model_alias.
    allow_caller_provider_override: bool = False

    class Config:
        env_prefix = ""
        extra = "ignore"

    def __init__(self, **kwargs):
        # BaseSettings is case-insensitive by default and would try to parse
        # UPSTREAM_TIMEOUT_SEC before this post-init env mapper runs. Seed
        # constructor defaults so our bounded parser below owns those values.
        kwargs.setdefault("upstream_timeout_sec", DEFAULT_UPSTREAM_TIMEOUT_SEC)
        kwargs.setdefault("upstream_rate_limit_retries", DEFAULT_RATE_LIMIT_RETRIES)
        kwargs.setdefault(
            "upstream_rate_limit_retry_delay_sec",
            DEFAULT_RATE_LIMIT_RETRY_DELAY_SEC,
        )
        kwargs.setdefault(
            "upstream_rate_limit_max_sleep_sec",
            DEFAULT_RATE_LIMIT_MAX_SLEEP_SEC,
        )
        super().__init__(**kwargs)
        env = os.environ
        # Map legacy/operator env names and apply gateway-specific guards.
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
        self.anthropic_version  = env.get("ANTHROPIC_VERSION", self.anthropic_version)
        self.anthropic_prompt_cache_beta = env.get(
            "ANTHROPIC_PROMPT_CACHE_BETA", self.anthropic_prompt_cache_beta,
        )
        self.prompt_cache_enabled = (
            env.get("LLM_PROMPT_CACHE_ENABLED", "true").lower() == "true"
        )
        self.upstream_timeout_sec = _bounded_int_env(
            env,
            "UPSTREAM_TIMEOUT_SEC",
            self.upstream_timeout_sec,
            min_value=1,
            max_value=3600,
        )
        self.upstream_rate_limit_retries = _bounded_int_env(
            env,
            "LLM_GATEWAY_RATE_LIMIT_RETRIES",
            self.upstream_rate_limit_retries,
            min_value=0,
            max_value=10,
        )
        self.upstream_rate_limit_retry_delay_sec = _bounded_float_env(
            env,
            "LLM_GATEWAY_RATE_LIMIT_RETRY_DELAY_SEC",
            self.upstream_rate_limit_retry_delay_sec,
            min_value=0.0,
            max_value=300.0,
        )
        self.upstream_rate_limit_max_sleep_sec = _bounded_float_env(
            env,
            "LLM_GATEWAY_RATE_LIMIT_MAX_SLEEP_SEC",
            self.upstream_rate_limit_max_sleep_sec,
            min_value=0.0,
            max_value=300.0,
        )
        self.gateway_bearer = env.get("LLM_GATEWAY_BEARER", "")
        self.allow_caller_provider_override = (
            env.get("ALLOW_CALLER_PROVIDER_OVERRIDE", "false").lower() == "true"
        )

        # Security gate: never serve provider-funded LLM calls without auth in a
        # production-class env. When real provider credentials are present but
        # LLM_GATEWAY_BEARER is empty, every request is unauthenticated (see
        # router._check_auth). Fail closed in prod; warn in dev so local runs work.
        _deploy_env = (
            env.get("APP_ENV") or env.get("ENVIRONMENT") or env.get("SINGULARITY_ENV") or env.get("NODE_ENV") or "development"
        ).lower()
        _has_real_creds = any([
            self.openai_api_key, self.openrouter_api_key, self.anthropic_api_key,
        ])
        if _has_real_creds and not self.gateway_bearer:
            _msg = (
                "LLM gateway has real provider credentials but LLM_GATEWAY_BEARER is empty — "
                "every request would be unauthenticated. Set LLM_GATEWAY_BEARER to a strong secret."
            )
            if _deploy_env in ("production", "prod", "staging", "perf"):
                raise RuntimeError(f"FATAL ({_deploy_env}): {_msg}")
            import sys as _sys
            print(f"[llm-gateway] WARNING ({_deploy_env}): {_msg}", file=_sys.stderr)

    def credential_for(self, provider: str) -> Optional[str]:
        p = provider.lower()
        if p in ("openai",):
            return self.openai_api_key
        if p == "openrouter":
            return self.openrouter_api_key
        if p == "anthropic":
            return self.anthropic_api_key
        if p == "mock":
            return "mock"  # mock needs no key
        return None


settings = Settings()
