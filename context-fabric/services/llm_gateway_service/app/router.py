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

import uuid
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Body, Header, HTTPException

from .config import settings
from . import audit_emit
from . import provider_config
from . import task_tags
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
) -> Tuple[str, str, Optional[str], str]:
    """Return (provider, model, resolved_alias, routing_source) or raise 400/503.

    routing_source records HOW the model was chosen, using the vocabulary the
    m75 llm_calls column documents: caller_pin | policy | default | fallback.
    Without it, "the caller asked for this" and "we picked this because nothing
    was configured" are indistinguishable on the cost row.
    """
    if model_alias:
        try:
            entry = provider_config.resolve_alias(model_alias)
            provider_config.validate_model_entry(entry, _credentials())
        except provider_config.ProviderNotReadyError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except provider_config.ProviderConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entry["provider"], entry["model"], model_alias, "caller_pin"

    if provider or model:
        if not settings.allow_caller_provider_override:
            raise HTTPException(status_code=400, detail="provider/model override disabled; pass model_alias")
        p = (provider or provider_config.default_provider()).lower()
        m = model or provider_config.provider_default_model(p)
        if not m:
            raise HTTPException(status_code=400, detail=f"no default model for provider {p}")
        reasons = provider_config.provider_unready_reasons(p, _credentials().get(p))
        if reasons:
            raise HTTPException(status_code=503, detail=f"provider {p} is not ready: {'; '.join(reasons)}")
        return p, m, None, "caller_pin"

    # No alias and no provider/model: use the configured default alias. If no
    # model catalog exists, the only implicit fallback allowed is mock.
    alias = provider_config.default_model_alias()
    if alias:
        try:
            entry = provider_config.resolve_alias(alias)
            provider_config.validate_model_entry(entry, _credentials())
        except provider_config.ProviderNotReadyError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except provider_config.ProviderConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return entry["provider"], entry["model"], alias, "default"
    p = provider_config.default_provider()
    if p == "mock":
        return "mock", provider_config.provider_default_model("mock") or "mock-fast", None, "fallback"
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
        "config": {
            "provider_config_path": settings.provider_config_path,
            "model_catalog_path": settings.model_catalog_path,
            "allow_caller_provider_override": settings.allow_caller_provider_override,
            "auth_required": bool(settings.gateway_bearer),
            "upstream_timeout_sec": settings.upstream_timeout_sec,
        },
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
        except provider_config.ProviderNotReadyError as exc:
            if not warnings:
                warnings.append(str(exc))
        except provider_config.ProviderConfigError as exc:
            warnings.append(str(exc))
        warnings = provider_config.unique_warnings(warnings)
        enriched.append({**entry, "ready": not warnings, "warnings": warnings})
    return {
        "default_model_alias": provider_config.default_model_alias(),
        "models": enriched,
        "warnings": provider_config.warnings(),
    }


# ── Catalog writes (UI-managed) — persist to llm-models.json, live reload ────
@router.post("/llm/models")
def create_model(body: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    _check_auth(authorization)
    try:
        return {"model": provider_config.add_model(body)}
    except provider_config.ProviderConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/llm/models/{model_id}")
def edit_model(model_id: str, body: Dict[str, Any] = Body(...), authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    _check_auth(authorization)
    try:
        return {"model": provider_config.update_model(model_id, body)}
    except provider_config.ProviderConfigError as exc:
        raise HTTPException(status_code=404 if str(exc).startswith("unknown model id") else 400, detail=str(exc))


@router.delete("/llm/models/{model_id}")
def remove_model(model_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    _check_auth(authorization)
    try:
        provider_config.delete_model(model_id)
    except provider_config.ProviderConfigError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": model_id}


@router.post("/v1/chat/completions", response_model=ChatCompletionResponse)
async def chat_completions(
    req: ChatCompletionRequest,
    authorization: Optional[str] = Header(None),
) -> ChatCompletionResponse:
    _check_auth(authorization)
    if req.stream:
        raise HTTPException(status_code=400, detail="streaming is not yet supported by the gateway; set stream=false")

    # Who is asking and why. Resolved before provider selection so an untagged
    # call is rejected (when required) before it costs anything upstream.
    identity = task_tags.resolve_task_identity(req, endpoint="chat_completions")

    # One identity for this call, minted before anything can fail, echoed on
    # the response and carried on the cost event so the two join exactly.
    gateway_call_id = str(uuid.uuid4())
    # Hash + length only. The joined prompt text never leaves this function.
    prompt_sha, prompt_chars = audit_emit.fingerprint_messages(req.messages)

    provider, model, alias, routing_source = _resolve_provider_and_model(
        model_alias=req.model_alias,
        provider=req.provider,
        model=req.model,
    )
    if req.expected_provider and provider.lower() != req.expected_provider.lower():
        raise HTTPException(
            status_code=409,
            detail=f"resolved provider {provider} does not match expected provider {req.expected_provider}",
        )
    if req.expected_model and model != req.expected_model:
        raise HTTPException(
            status_code=409,
            detail=f"resolved model {model} does not match expected model {req.expected_model}",
        )
    if not provider_config.is_provider_allowed(provider):
        raise HTTPException(status_code=400, detail=f"provider {provider} is not allowed by gateway config")

    if provider == "mock":
        resp = await mock_provider.respond(req, resolved_model=model)
        resp.gateway_call_id = gateway_call_id
        # Mock has no real cost; leave as zero (the mock provider already
        # sets estimated_cost=0 on its responses). Still audited: a mock run
        # that never appears in the log looks like a run that never happened.
        task_tags.emit_call_audit(
            endpoint="chat_completions", identity=identity, provider=provider, model=model,
            model_alias=alias or req.model_alias, req=req,
            input_tokens=resp.input_tokens, output_tokens=resp.output_tokens, estimated_cost=0.0,
        )
        _emit_chat_cost_event(
            gateway_call_id=gateway_call_id, req=req, resp=resp, identity=identity,
            provider=provider, model=model, alias=alias, routing_source=routing_source,
            prompt_sha=prompt_sha, prompt_chars=prompt_chars,
        )
        return resp

    credential = settings.credential_for(provider)
    if not credential:
        raise HTTPException(status_code=503, detail=f"provider {provider} is not configured (missing credential)")

    try:
        if provider in ("openai", "openrouter"):
            resp = await openai_provider.respond(
                req, provider=provider, resolved_model=model, api_key=credential, model_alias=alias,
            )
        elif provider == "anthropic":
            resp = await anthropic_provider.respond(
                req, resolved_model=model, api_key=credential, model_alias=alias,
            )
        else:
            raise HTTPException(status_code=400, detail=f"unsupported provider {provider}")
    except anthropic_provider.AnthropicUpstreamError as exc:
        status = 429 if exc.status_code == 429 else 502
        raise HTTPException(status_code=status, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")

    # M56 — attach USD cost based on the catalog's per-model price.
    # Computed AFTER the provider call so we know the real token counts.
    # Null when no price is configured (UI shows "—" rather than $0.00).
    resp.estimated_cost = provider_config.compute_estimated_cost(
        alias or req.model_alias,
        resp.input_tokens,
        resp.output_tokens,
    )
    resp.gateway_call_id = gateway_call_id
    task_tags.emit_call_audit(
        endpoint="chat_completions", identity=identity, provider=provider, model=model,
        model_alias=alias or req.model_alias, req=req,
        input_tokens=resp.input_tokens, output_tokens=resp.output_tokens,
        estimated_cost=resp.estimated_cost,
    )
    _emit_chat_cost_event(
        gateway_call_id=gateway_call_id, req=req, resp=resp, identity=identity,
        provider=provider, model=model, alias=alias, routing_source=routing_source,
        prompt_sha=prompt_sha, prompt_chars=prompt_chars,
    )
    return resp


def _emit_chat_cost_event(
    *,
    gateway_call_id: str,
    req: ChatCompletionRequest,
    resp: ChatCompletionResponse,
    identity: Dict[str, Optional[str]],
    provider: str,
    model: str,
    alias: Optional[str],
    routing_source: str,
    prompt_sha: Optional[str],
    prompt_chars: Optional[int],
) -> None:
    """Hand the completed call to the cost emitter.

    Dark by default (GATEWAY_AUDIT_EMIT_ENABLED), fire-and-forget, and it never
    raises — see audit_emit's module docstring. `task_tags.emit_call_audit`
    above stays the last-resort record whether or not this lands.
    """
    response_sha, response_chars = audit_emit.fingerprint(resp.content)
    audit_emit.emit_llm_call(
        gateway_call_id=gateway_call_id,
        endpoint="chat_completions",
        provider=provider,
        model=model,
        model_alias=alias or req.model_alias,
        identity=identity,
        input_tokens=resp.input_tokens,
        output_tokens=resp.output_tokens,
        latency_ms=resp.latency_ms,
        finish_reason=resp.finish_reason,
        routing_source=routing_source,
        estimated_cost=resp.estimated_cost,
        trace_id=req.trace_id,
        capability_id=req.capability_id,
        tenant_id=req.tenant_id,
        actor_id=req.actor_id,
        run_id=req.run_id,
        prompt_sha256=prompt_sha,
        prompt_chars=prompt_chars,
        response_sha256=response_sha,
        response_chars=response_chars,
    )


@router.post("/v1/embeddings", response_model=EmbeddingsResponse)
async def embeddings(
    req: EmbeddingsRequest,
    authorization: Optional[str] = Header(None),
) -> EmbeddingsResponse:
    _check_auth(authorization)
    if not req.input:
        raise HTTPException(status_code=400, detail="input must be a non-empty list of strings")

    identity = task_tags.resolve_task_identity(req, endpoint="embeddings")

    gateway_call_id = str(uuid.uuid4())
    # Input texts are fingerprinted, never carried. Embeddings are the
    # highest-volume traffic here, so this is the path where shipping text
    # would hurt most — in bytes on the wire and in what ends up retained.
    prompt_sha, prompt_chars = audit_emit.fingerprint(
        "\x1e".join(t for t in req.input if isinstance(t, str))
    )

    provider, model, alias, routing_source = _resolve_provider_and_model(
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
        latency_ms = int((time.time() - start) * 1000)
        task_tags.emit_call_audit(
            endpoint="embeddings", identity=identity, provider="mock", model=model or "mock-embed",
            model_alias=alias, req=req, input_tokens=tokens,
        )
        _emit_embedding_cost_event(
            gateway_call_id=gateway_call_id, req=req, identity=identity, provider="mock",
            model=model or "mock-embed", alias=alias, routing_source=routing_source,
            input_tokens=tokens, latency_ms=latency_ms,
            prompt_sha=prompt_sha, prompt_chars=prompt_chars,
        )
        return EmbeddingsResponse(
            embeddings=vectors,
            dim=dim,
            provider="mock",
            model=model or "mock-embed",
            model_alias=alias,
            input_tokens=tokens,
            latency_ms=latency_ms,
            gateway_call_id=gateway_call_id,
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
            latency_ms = int((time.time() - start) * 1000)
            task_tags.emit_call_audit(
                endpoint="embeddings", identity=identity, provider=provider, model=model,
                model_alias=alias, req=req, input_tokens=tokens,
            )
            _emit_embedding_cost_event(
                gateway_call_id=gateway_call_id, req=req, identity=identity, provider=provider,
                model=model, alias=alias, routing_source=routing_source,
                input_tokens=tokens, latency_ms=latency_ms,
                prompt_sha=prompt_sha, prompt_chars=prompt_chars,
            )
            return EmbeddingsResponse(
                embeddings=vectors,
                dim=dim,
                provider=provider,
                model=model,
                model_alias=alias,
                input_tokens=tokens,
                latency_ms=latency_ms,
                gateway_call_id=gateway_call_id,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")
    raise HTTPException(status_code=400, detail=f"embeddings not supported for provider {provider}")


def _emit_embedding_cost_event(
    *,
    gateway_call_id: str,
    req: EmbeddingsRequest,
    identity: Dict[str, Optional[str]],
    provider: str,
    model: str,
    alias: Optional[str],
    routing_source: str,
    input_tokens: int,
    latency_ms: int,
    prompt_sha: Optional[str],
    prompt_chars: Optional[int],
) -> None:
    """Cost event for an embeddings call.

    output_tokens is 0 — embeddings produce vectors, not tokens — and there is
    no response fingerprint for the same reason: a vector is not content a
    hash of which would tell anyone anything.
    """
    audit_emit.emit_llm_call(
        gateway_call_id=gateway_call_id,
        endpoint="embeddings",
        provider=provider,
        model=model,
        model_alias=alias or req.model_alias,
        identity=identity,
        input_tokens=input_tokens,
        output_tokens=0,
        latency_ms=latency_ms,
        routing_source=routing_source,
        estimated_cost=provider_config.compute_estimated_cost(
            alias or req.model_alias, input_tokens, 0,
        ),
        trace_id=req.trace_id,
        capability_id=req.capability_id,
        tenant_id=req.tenant_id,
        actor_id=req.actor_id,
        prompt_sha256=prompt_sha,
        prompt_chars=prompt_chars,
    )
