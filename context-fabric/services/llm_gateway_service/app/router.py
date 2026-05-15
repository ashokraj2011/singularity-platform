"""M33 — Gateway HTTP routes.

Two primary endpoints:
    POST /v1/chat/completions
    POST /v1/embeddings
Plus introspection:
    GET  /health
    GET  /llm/providers       — provider status (no secrets)
    GET  /llm/models          — alias catalog
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException

from .config import settings
from . import provider_config
from .providers import anthropic as anthropic_provider
from .providers import mock as mock_provider
from .providers import openai_compat as openai_provider
from .types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    EmbeddingsRequest,
    EmbeddingsResponse,
)


router = APIRouter()


def _credentials() -> Dict[str, Optional[str]]:
    return {
        "openai":     settings.openai_api_key,
        "openrouter": settings.openrouter_api_key,
        "anthropic":  settings.anthropic_api_key,
        "copilot":    settings.copilot_token,
        "mock":       "mock",
    }


def _check_auth(authorization: Optional[str]) -> None:
    if not settings.gateway_bearer:
        return  # auth disabled (dev)
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer")
    token = authorization.split(" ", 1)[1].strip()
    if token != settings.gateway_bearer:
        raise HTTPException(status_code=401, detail="bad bearer")


def _resolve_provider_and_model(
    *,
    model_alias: Optional[str],
    provider: Optional[str],
    model: Optional[str],
) -> Tuple[str, str, Optional[str]]:
    """Return (provider, model, resolved_alias) or raise 400 / 503."""
    if model_alias:
        try:
            entry = provider_config.resolve_alias(model_alias)
            provider_config.validate_model_entry(entry, _credentials())
        except provider_config.ProviderConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entry["provider"], entry["model"], model_alias

    if provider or model:
        if not settings.allow_caller_provider_override:
            raise HTTPException(status_code=400, detail="provider/model override disabled; pass model_alias")
        p = (provider or provider_config.default_provider()).lower()
        m = model or provider_config.provider_default_model(p)
        if not m:
            raise HTTPException(status_code=400, detail=f"no default model for provider {p}")
        reasons = provider_config.provider_unready_reasons(p, _credentials().get(p))
        if reasons:
            raise HTTPException(status_code=400, detail=f"provider {p} is not ready: {'; '.join(reasons)}")
        return p, m, None

    # No alias and no provider/model: use the configured default alias. If no
    # model catalog exists, the only implicit fallback allowed is mock.
    alias = provider_config.default_model_alias()
    if alias:
        try:
            entry = provider_config.resolve_alias(alias)
            provider_config.validate_model_entry(entry, _credentials())
        except provider_config.ProviderConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entry["provider"], entry["model"], alias
    p = provider_config.default_provider()
    if p == "mock":
        return "mock", provider_config.provider_default_model("mock") or "mock-fast", None
    raise HTTPException(status_code=400, detail="model_alias is required; no default alias is configured")


@router.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "llm-gateway", "version": "0.1.0"}


@router.get("/llm/providers")
def list_providers(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    _check_auth(authorization)
    credentials = _credentials()
    return {
        "default_provider": provider_config.default_provider(),
        "default_model_alias": provider_config.default_model_alias(),
        "providers": provider_config.list_provider_status(credentials),
        "warnings": provider_config.warnings(),
    }


@router.get("/llm/models")
def list_models(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    _check_auth(authorization)
    catalog = provider_config._load_catalog()  # noqa: SLF001 — internal helper
    credentials = _credentials()
    statuses = {row["name"]: row for row in provider_config.list_provider_status(credentials)}
    enriched = []
    for entry in catalog:
        provider = entry.get("provider")
        status = statuses.get(provider, {})
        warnings = list(status.get("warnings", []))
        try:
            provider_config.validate_model_entry(entry, credentials)
        except provider_config.ProviderConfigError as exc:
            warnings.append(str(exc))
        enriched.append({**entry, "ready": not warnings, "warnings": warnings})
    return {
        "default_model_alias": provider_config.default_model_alias(),
        "models": enriched,
        "warnings": provider_config.warnings(),
    }


@router.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def chat_completions(
    req: ChatCompletionRequest,
    authorization: Optional[str] = Header(None),
) -> ChatCompletionResponse:
    _check_auth(authorization)
    if req.stream:
        raise HTTPException(status_code=400, detail="streaming is not yet supported by the gateway; set stream=false")

    provider, model, alias = _resolve_provider_and_model(
        model_alias=req.model_alias,
        provider=req.provider,
        model=req.model,
    )
    if not provider_config.is_provider_allowed(provider):
        raise HTTPException(status_code=400, detail=f"provider {provider} is not allowed by gateway config")

    if provider == "mock":
        return await mock_provider.respond(req, resolved_model=model)

    credential = settings.credential_for(provider)
    if not credential:
        raise HTTPException(status_code=503, detail=f"provider {provider} is not configured (missing credential)")

    try:
        if provider in ("openai", "openrouter", "copilot"):
            return await openai_provider.respond(
                req, provider=provider, resolved_model=model, api_key=credential, model_alias=alias,
            )
        if provider == "anthropic":
            return await anthropic_provider.respond(
                req, resolved_model=model, api_key=credential, model_alias=alias,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")
    raise HTTPException(status_code=400, detail=f"unsupported provider {provider}")


@router.post("/v1/embeddings", response_model=EmbeddingsResponse)
async def embeddings(
    req: EmbeddingsRequest,
    authorization: Optional[str] = Header(None),
) -> EmbeddingsResponse:
    _check_auth(authorization)
    if not req.input:
        raise HTTPException(status_code=400, detail="input must be a non-empty list of strings")

    provider, model, alias = _resolve_provider_and_model(
        model_alias=req.model_alias,
        provider=req.provider,
        model=req.model,
    )
    if not provider_config.is_provider_allowed(provider):
        raise HTTPException(status_code=400, detail=f"provider {provider} is not allowed by gateway config")

    import time
    start = time.time()
    if provider == "mock":
        vectors, tokens = await mock_provider.embed(req.input, resolved_model=model or "mock-embed")
        dim = len(vectors[0]) if vectors else 0
        return EmbeddingsResponse(
            embeddings=vectors,
            dim=dim,
            provider="mock",
            model=model or "mock-embed",
            model_alias=alias,
            input_tokens=tokens,
            latency_ms=int((time.time() - start) * 1000),
        )

    credential = settings.credential_for(provider)
    if not credential:
        raise HTTPException(status_code=503, detail=f"provider {provider} is not configured (missing credential)")

    try:
        if provider in ("openai", "openrouter"):
            vectors, tokens = await openai_provider.embed(
                req.input, provider=provider, resolved_model=model, api_key=credential,
            )
            dim = len(vectors[0]) if vectors else 0
            return EmbeddingsResponse(
                embeddings=vectors,
                dim=dim,
                provider=provider,
                model=emb_model,
                model_alias=alias,
                input_tokens=tokens,
                latency_ms=int((time.time() - start) * 1000),
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")
    raise HTTPException(status_code=400, detail=f"embeddings not supported for provider {provider}")
