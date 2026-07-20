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

from types import SimpleNamespace
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Body, Header, HTTPException

from .config import settings
from . import model_policy
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
    RoutePreviewRequest,
    RoutePreviewResponse,
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
) -> Tuple[str, str, Optional[str]]:
    """Return (provider, model, resolved_alias) or raise 400 / 503."""
    if model_alias:
        try:
            entry = provider_config.resolve_alias(model_alias)
            provider_config.validate_model_entry(entry, _credentials())
        except provider_config.ProviderNotReadyError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
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
            raise HTTPException(status_code=503, detail=f"provider {p} is not ready: {'; '.join(reasons)}")
        return p, m, None

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
        return entry["provider"], entry["model"], alias
    p = provider_config.default_provider()
    if p == "mock":
        return "mock", provider_config.provider_default_model("mock") or "mock-fast", None
    raise HTTPException(status_code=400, detail="model_alias is required; no default alias is configured")


def _alias_ready(alias: str) -> bool:
    """Whether a catalog alias can actually serve traffic right now.

    The readiness probe the policy engine walks its tier list with. Deliberately
    the SAME two calls _resolve_provider_and_model makes, so an alias policy
    considers ready is exactly one that would not have 503'd. (validate_model_entry
    already covers is_provider_allowed, via provider_unready_reasons.)
    """
    try:
        entry = provider_config.resolve_alias(alias)
        provider_config.validate_model_entry(entry, _credentials())
    except provider_config.ProviderConfigError:
        return False
    return True


def _resolve_provider_and_model_with_policy(
    *,
    req: Any,
    identity: Dict[str, Optional[str]],
    estimated_input_tokens: Optional[int] = None,
) -> Tuple[str, str, Optional[str], Optional[Dict[str, Any]]]:
    """Resolution with the B1 policy engine in front of it.

    While GATEWAY_MODEL_POLICY_ENABLED is unset — the default — this returns
    before touching the policy engine at all, so the resolution path is
    byte-identical to the pre-policy gateway and the routing block is absent.
    That early return is the feature gate; everything below it is dark.
    """
    if not model_policy.policy_enabled():
        provider, model, alias = _resolve_provider_and_model(
            model_alias=req.model_alias,
            provider=req.provider,
            model=req.model,
        )
        return provider, model, alias, None

    decision = model_policy.resolve(
        model_alias=req.model_alias,
        expected_model=req.expected_model,
        model_tier=getattr(req, "model_tier", None),
        task_tag=identity.get("task_tag"),
        stage=identity.get("stage"),
        purpose=identity.get("purpose"),
        estimated_input_tokens=(
            estimated_input_tokens
            if estimated_input_tokens is not None
            else model_policy.estimate_input_tokens(getattr(req, "messages", None))
        ),
        is_ready=_alias_ready,
    )
    # A decision with no alias (an expected_model pin, or any degrade) leaves the
    # caller's own alias in place — policy never removes a choice, it only makes
    # one where there was none.
    chosen_alias = decision.alias if (decision and decision.alias) else req.model_alias
    provider, model, alias = _resolve_provider_and_model(
        model_alias=chosen_alias,
        provider=req.provider,
        model=req.model,
    )
    return provider, model, alias, (decision.as_dict() if decision else None)


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
        "policy": model_policy.describe(),
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


@router.post("/llm/route/preview", response_model=RoutePreviewResponse)
def preview_route(
    req: RoutePreviewRequest,
    authorization: Optional[str] = Header(None),
) -> RoutePreviewResponse:
    """Resolve a call WITHOUT making it.

    context-fabric needs the model before the call, not after: its token-budget
    preflight has to know the context window it is packing for, and a caller
    doing an `expected_model` drift check needs something to compare against.
    Without this, a policy-routed caller could only learn its model by spending
    a provider call to find out.

    Runs the SAME resolution function the real endpoints run. Duplicating the
    logic here would produce a preview that agrees with the call right up until
    the day it quietly stops.
    """
    _check_auth(authorization)
    identity = task_tags.resolve_task_identity(req, endpoint="route_preview")
    # A caller that knows its size but not its content sends the size. Passed
    # through as a number rather than as a synthesised message: building a
    # stand-in string would let any caller allocate megabytes by naming a large
    # token count, on an endpoint whose whole point is that it is cheap.
    estimated = max(
        req.estimated_input_tokens
        if req.estimated_input_tokens is not None
        else model_policy.estimate_input_tokens(req.messages),
        0,
    )
    shim = SimpleNamespace(
        model_alias=req.model_alias,
        provider=req.provider,
        model=req.model,
        expected_model=req.expected_model,
        model_tier=req.model_tier,
        messages=None,
    )
    try:
        provider, model, alias, routing = _resolve_provider_and_model_with_policy(
            req=shim, identity=identity, estimated_input_tokens=estimated,
        )
    except HTTPException as exc:
        return RoutePreviewResponse(
            policy_enabled=model_policy.policy_enabled(),
            estimated_input_tokens=estimated,
            ready=False,
            error=str(exc.detail),
            warnings=model_policy.warnings(),
        )
    return RoutePreviewResponse(
        provider=provider,
        model=model,
        model_alias=alias,
        routing=routing,
        policy_enabled=model_policy.policy_enabled(),
        estimated_input_tokens=estimated,
        ready=True,
        warnings=model_policy.warnings(),
    )


@router.get("/llm/policy")
def get_policy(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    """What policy is loaded and whether it is live. Config, never secrets."""
    _check_auth(authorization)
    return model_policy.describe()


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

    provider, model, alias, routing = _resolve_provider_and_model_with_policy(
        req=req, identity=identity,
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
        resp.routing = routing
        # Mock has no real cost; leave as zero (the mock provider already
        # sets estimated_cost=0 on its responses). Still audited: a mock run
        # that never appears in the log looks like a run that never happened.
        task_tags.emit_call_audit(
            endpoint="chat_completions", identity=identity, provider=provider, model=model,
            model_alias=alias or req.model_alias, req=req,
            input_tokens=resp.input_tokens, output_tokens=resp.output_tokens, estimated_cost=0.0,
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
    resp.routing = routing
    task_tags.emit_call_audit(
        endpoint="chat_completions", identity=identity, provider=provider, model=model,
        model_alias=alias or req.model_alias, req=req,
        input_tokens=resp.input_tokens, output_tokens=resp.output_tokens,
        estimated_cost=resp.estimated_cost,
    )
    return resp


@router.post("/v1/embeddings", response_model=EmbeddingsResponse)
async def embeddings(
    req: EmbeddingsRequest,
    authorization: Optional[str] = Header(None),
) -> EmbeddingsResponse:
    _check_auth(authorization)
    if not req.input:
        raise HTTPException(status_code=400, detail="input must be a non-empty list of strings")

    identity = task_tags.resolve_task_identity(req, endpoint="embeddings")

    # Note what is deliberately NOT wired here: size escalation. An
    # EmbeddingsRequest carries `input`, not `messages`, so the estimate is 0 and
    # embeddings never escalate a tier — which is correct, not an oversight.
    # Routing a long input to a "deeper" embedding model would write vectors from
    # a second model into the same index, and that is precisely the silent
    # corruption the expected_model drift guard below exists to catch. Tier
    # routing and the readiness walk still apply.
    provider, model, alias, routing = _resolve_provider_and_model_with_policy(
        req=req, identity=identity,
    )
    # Drift guard, matching /v1/chat/completions. This matters MORE here: a
    # silently-changed chat model produces one visibly-off answer, whereas a
    # silently-changed embedding model corrupts a vector index, and mixing
    # 1536-dim mock vectors into a real one is not detectable by reading rows.
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

    import time
    start = time.time()
    if provider == "mock":
        vectors, tokens = await mock_provider.embed(req.input, resolved_model=model or "mock-embed")
        dim = len(vectors[0]) if vectors else 0
        task_tags.emit_call_audit(
            endpoint="embeddings", identity=identity, provider="mock", model=model or "mock-embed",
            model_alias=alias, req=req, input_tokens=tokens,
        )
        return EmbeddingsResponse(
            embeddings=vectors,
            dim=dim,
            provider="mock",
            model=model or "mock-embed",
            model_alias=alias,
            input_tokens=tokens,
            latency_ms=int((time.time() - start) * 1000),
            estimated_cost=provider_config.compute_embedding_cost(alias, tokens),
            routing=routing,
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
            task_tags.emit_call_audit(
                endpoint="embeddings", identity=identity, provider=provider, model=model,
                model_alias=alias, req=req, input_tokens=tokens,
            )
            return EmbeddingsResponse(
                embeddings=vectors,
                dim=dim,
                provider=provider,
                model=model,
                model_alias=alias,
                input_tokens=tokens,
                latency_ms=int((time.time() - start) * 1000),
                estimated_cost=provider_config.compute_embedding_cost(alias, tokens),
                routing=routing,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM_GATEWAY_UPSTREAM: {exc}")
    raise HTTPException(status_code=400, detail=f"embeddings not supported for provider {provider}")
