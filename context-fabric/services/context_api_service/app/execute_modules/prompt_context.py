"""
M73 — prompt + context-package assembly for the legacy /execute path.

Five pieces:

  context_plan_status      — interpret the contextPlan returned by
                             prompt-composer preview; flag missing
                             required layers so the governance step can
                             decide whether to block.
  context_plan_message     — human-readable summary for the governance
                             denial response (Workbench renders it
                             verbatim).
  build_code_context_package — call mcp-server /mcp/code-context/build to
                             materialise a budgeted AST/code-context
                             package keyed to the task text.
  fetch_capability_world_model — pull the CODE_AGENT_RULES /
                             CODE_WORLD_MODEL layer from agent-runtime so
                             prompt-composer can include it.
  composer_context_policy  — normalise the caller's context_policy +
                             limits into the shape compose-and-respond
                             expects.
  compile_execute_context  — invoke context-memory's /context/compile to
                             expand the message history with summaries +
                             prior turns.

Everything here is best-effort: a 404 / network / malformed response
returns (None, warning) so the orchestrator can degrade gracefully.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

import httpx

from ..config import settings
from ..env_config import bounded_float_value
from ..response_json import response_json_object
from .response_mapper import int_limit, str_value, trim_text

_DEFAULT_CONTEXT_COMPILE_TIMEOUT_SEC = 20.0
_DEFAULT_CODE_CONTEXT_BUILD_TIMEOUT_SEC = 45.0
_MAX_SERVICE_BOUNDARY_TIMEOUT_SEC = 300.0
_MAX_CODE_CONTEXT_BUILD_TIMEOUT_SEC = 3600.0


async def _post(
    url: str,
    payload: dict,
    timeout: float = 60.0,
    headers: Optional[dict] = None,
) -> dict:
    """Bare httpx POST helper used by the legacy code path. The governed
    loop (Slice B/C(b)) uses its own dispatch.py — that's deliberate so
    the two paths can be tested independently."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return response_json_object(resp, "legacy execute POST")


def context_compile_timeout_sec() -> float:
    return bounded_float_value(
        os.getenv("CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC", str(_DEFAULT_CONTEXT_COMPILE_TIMEOUT_SEC)),
        default=_DEFAULT_CONTEXT_COMPILE_TIMEOUT_SEC,
        min_value=1.0,
        max_value=_MAX_SERVICE_BOUNDARY_TIMEOUT_SEC,
        name="CONTEXT_FABRIC_CONTEXT_COMPILE_TIMEOUT_SEC",
    )


def code_context_build_timeout_sec() -> float:
    return bounded_float_value(
        os.getenv(
            "CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC",
            str(_DEFAULT_CODE_CONTEXT_BUILD_TIMEOUT_SEC),
        ),
        default=_DEFAULT_CODE_CONTEXT_BUILD_TIMEOUT_SEC,
        min_value=1.0,
        max_value=_MAX_CODE_CONTEXT_BUILD_TIMEOUT_SEC,
        name="CONTEXT_FABRIC_CODE_CONTEXT_BUILD_TIMEOUT_SEC",
    )


def context_plan_status(
    context_plan: Optional[dict[str, Any]],
    composer_available: bool,
) -> dict[str, Any]:
    """Summarise the prompt-composer ContextPlan into a validity decision.
    Three failure shapes:
      - composer_unavailable  — preview call itself failed.
      - context_plan_missing  — preview succeeded but didn't include a plan.
      - missing_required_context — plan exists but flags required layers
                                  the workflow couldn't supply (M28).
    """
    if not composer_available:
        return {
            "valid": False,
            "reason": "composer_unavailable",
            "missingRequired": [{
                "layerType": "CONTEXT_PLAN",
                "reason": "Prompt Composer did not return a ContextPlan.",
            }],
            "contextPlanHash": None,
        }
    if not context_plan:
        return {
            "valid": False,
            "reason": "context_plan_missing",
            "missingRequired": [{
                "layerType": "CONTEXT_PLAN",
                "reason": "Prompt Composer preview did not include contextPlan.",
            }],
            "contextPlanHash": None,
        }
    missing = context_plan.get("missingRequired") or []
    valid = bool(context_plan.get("valid")) and not missing
    return {
        "valid": valid,
        "reason": None if valid else "missing_required_context",
        "missingRequired": missing,
        "contextPlanHash": context_plan.get("contextPlanHash"),
        "requiredLayers": context_plan.get("requiredLayers") or [],
        "selectedLayerCount": len(context_plan.get("selectedLayers") or []),
    }


def context_plan_message(status: dict[str, Any]) -> str:
    """Human-readable explanation for a failed ContextPlan check. Surfaced
    on the Workbench failure card so operators can fix the workflow input
    rather than retry blindly."""
    missing = status.get("missingRequired") or []
    if not missing:
        return str(status.get("reason") or "ContextPlan is invalid.")
    names = ", ".join(
        str(m.get("layerType") or "unknown") for m in missing if isinstance(m, dict)
    )
    return f"Required prompt context is missing: {names or 'unknown'}."


async def build_code_context_package(
    mcp_base_url: str,
    mcp_token: str,
    req: Any,
    trace_id: Optional[str],
) -> tuple[Optional[dict], Optional[str]]:
    """
    M52 — Call mcp-server's /mcp/code-context/build before prompt composition.
    Returns (package_dict, warning). On failure returns (None, warning_text)
    so the compose path can degrade gracefully to the legacy CODE_CONTEXT
    layer. Never raises — code-context budgeting is best-effort.
    """
    url = f"{mcp_base_url.rstrip('/')}/mcp/code-context/build"
    payload: dict[str, Any] = {
        "task_text": req.task,
        "max_token_budget": 7000,
        "include_tests": True,
    }
    if trace_id:
        payload["trace_id"] = trace_id
    if req.run_context.capability_id:
        payload["capability_id"] = req.run_context.capability_id
    try:
        body = await _post(
            url,
            payload,
            timeout=code_context_build_timeout_sec(),
            headers={"authorization": f"Bearer {mcp_token}"} if mcp_token else None,
        )
        if not body.get("success"):
            return None, f"mcp.code_context.skipped: backend returned success=false ({str(body)[:200]})"
        pkg = body.get("data")
        if not isinstance(pkg, dict) or not pkg.get("context_package_id"):
            return None, "mcp.code_context.skipped: malformed response (missing context_package_id)"
        return pkg, None
    except httpx.HTTPStatusError as exc:
        return None, f"mcp.code_context.skipped: HTTP {exc.response.status_code} from {url}"
    except (httpx.RequestError, asyncio.TimeoutError) as exc:
        return None, f"mcp.code_context.skipped: transport error {exc!s}"
    except Exception as exc:  # pylint: disable=broad-except
        return None, f"mcp.code_context.skipped: unexpected error {exc!s}"


def agent_runtime_api_base(agent_runtime_url: Optional[str]) -> str:
    """Normalise an agent-runtime base URL to its API root.

    agent-runtime mounts every resource under ``/api/v1`` (app.ts), but
    ``AGENT_RUNTIME_URL`` is configured as a bare host:port in every deployment
    path we ship — docker-compose, bin/docker-core.sh, bin/bare-metal.sh,
    bin/configure-platform.py. So the prefix has to be added here.

    Both world-model fetches below used the bare value and therefore requested
    ``/capabilities/:id/world-model*``, which 404s. That was invisible: the slice
    fetch treats 404 as "this capability has no world model yet" and returns no
    warning at all, so every consumer — the composed /execute path, the governed
    stage loop, and the copilot executor — silently rendered no CODE_AGENT_RULES
    and no CODE_WORLD_MODEL layers, indistinguishable from a capability that had
    genuinely never been distilled.

    Idempotent, so a deployment that later sets the variable WITH the suffix
    keeps working. Mirrors ``_agent_runtime_api_base`` in execute.py, which is
    how every other agent-runtime call in this service already builds its URL.
    """
    base = (agent_runtime_url or "").rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/api/v1") else f"{base}/api/v1"


def _agent_runtime_headers() -> Optional[dict]:
    """Auth for the agent-runtime world-model reads.

    agent-runtime gates `/api/v1/capabilities` with `requireAuth`, which accepts
    a service principal (`servicePrincipalFromToken`, auth.middleware.ts:123).
    These two fetches previously sent no Authorization header at all, so once the
    M61 URL bug was fixed the 404 simply became a 401 — the same silent
    "world_model.skipped" outcome, a different status code. Verified against a
    live stack: `/capabilities/...` 404s, `/api/v1/capabilities/...` 401s.

    None when no token is configured, which preserves today's behaviour for a
    deployment running agent-runtime without auth.
    """
    token = (settings.iam_service_token or "").strip()
    return {"authorization": f"Bearer {token}"} if token else None


async def fetch_capability_world_model(
    agent_runtime_url: str,
    capability_id: str,
    timeout_sec: float,
) -> tuple[Optional[dict], Optional[str]]:
    """
    M61 Wire 2 — GET ${agent_runtime_url}/capabilities/:id/world-model.

    Returns (world_model_dict, warning). The body shape matches
    ComposeInput.worldModel exactly (the prompt-composer Slice F
    renderers consume it unmodified) so callers can forward without
    transformation.

    Best-effort: any failure (404 / network / timeout) returns
    (None, warning_text). Compose then proceeds without the
    CODE_AGENT_RULES / CODE_WORLD_MODEL layers — those layers are
    additive context, not load-bearing for the workflow.

    Never raises.
    """
    if not agent_runtime_url or not capability_id:
        return None, None
    url = f"{agent_runtime_api_base(agent_runtime_url)}/capabilities/{capability_id}/world-model"
    try:
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.get(url, headers=_agent_runtime_headers())
        if resp.status_code == 404:
            # Capability exists but no world-model row has been seeded yet
            # (pre-M61 bootstrap, or Phase 1 worker still running). Not a
            # failure.
            return None, "world_model.skipped: not yet generated (404)"
        resp.raise_for_status()
        body = response_json_object(resp, "agent-runtime world-model")
        # agent-runtime wraps responses in {success, data, requestId}. The
        # view we want lives on `data`; tolerate both shapes for
        # forward-compat (older test fixtures return the view directly).
        wm = body.get("data") if isinstance(body, dict) and "data" in body else body
        if not isinstance(wm, dict) or not wm.get("capabilityId"):
            return None, "world_model.skipped: malformed response (missing capabilityId)"
        return wm, None
    except httpx.HTTPStatusError as exc:
        return None, f"world_model.skipped: HTTP {exc.response.status_code} from {url}"
    except (httpx.RequestError, asyncio.TimeoutError) as exc:
        return None, f"world_model.skipped: transport error {exc!s}"
    except Exception as exc:  # pylint: disable=broad-except
        return None, f"world_model.skipped: unexpected error {exc!s}"


async def fetch_capability_world_model_slice(
    agent_runtime_url: str,
    capability_id: str,
    timeout_sec: float,
    role: Optional[str] = None,
    task: Optional[str] = None,
    domain_key: Optional[str] = None,
) -> tuple[Optional[dict], list[dict], Optional[str]]:
    """
    GET ${agent_runtime_url}/capabilities/:id/world-model/slice?role=...

    The role-aware replacement for fetch_capability_world_model. Returns
    (world_model, views, warning): the capability-wide model in exactly the
    shape ComposeInput.worldModel expects, PLUS the role-scoped views for
    ComposeInput.worldModelViews.

    Both halves are independently optional and that is deliberate:
      - views empty  → the capability has no views built yet. This is the normal
        state and the result is byte-identical to the pre-slice behaviour.
      - world_model None, views present → a parent capability with no repository,
        whose views were built from its description, knowledge artifacts and
        children. A valid slice.

    Returns a THIRD element the caller must act on: `warning` is set when the
    slice endpoint could not be reached at all (old agent-runtime, network,
    timeout). The caller falls back to the capability-wide fetch in that case, so
    a runtime that predates the slice endpoint degrades to exactly today's bytes.

    Never raises.
    """
    if not agent_runtime_url or not capability_id:
        return None, [], None
    url = f"{agent_runtime_api_base(agent_runtime_url)}/capabilities/{capability_id}/world-model/slice"
    params: dict[str, str] = {}
    if role:
        params["role"] = role
    if task:
        params["task"] = task
    if domain_key:
        params["domainKey"] = domain_key
    try:
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.get(url, params=params, headers=_agent_runtime_headers())
        if resp.status_code == 404:
            # Neither a world model nor any views. Not a failure, and NOT a
            # reason to fall back — the legacy endpoint would 404 too.
            return None, [], None
        resp.raise_for_status()
        body = response_json_object(resp, "agent-runtime world-model slice")
        slice_body = body.get("data") if isinstance(body, dict) and "data" in body else body
        if not isinstance(slice_body, dict):
            return None, [], "world_model_slice.fallback: malformed response"
        world_model = slice_body.get("worldModel")
        if not isinstance(world_model, dict) or not world_model.get("capabilityId"):
            world_model = None
        raw_views = slice_body.get("views")
        views = [v for v in raw_views if isinstance(v, dict) and v.get("contentMd")] if isinstance(raw_views, list) else []
        return world_model, views, None
    except httpx.HTTPStatusError as exc:
        # A 404 on the ROUTE (older agent-runtime without the slice endpoint) is
        # handled above; anything else here means the endpoint exists but failed,
        # so fall back rather than dropping grounding entirely.
        return None, [], f"world_model_slice.fallback: HTTP {exc.response.status_code} from {url}"
    except (httpx.RequestError, asyncio.TimeoutError) as exc:
        return None, [], f"world_model_slice.fallback: transport error {exc!s}"
    except Exception as exc:  # pylint: disable=broad-except
        return None, [], f"world_model_slice.fallback: unexpected error {exc!s}"


def composer_context_policy(
    policy: dict[str, Any],
    limits: dict[str, Any],
) -> dict[str, Any]:
    """Normalise the caller's free-form context_policy + limits into the
    keys prompt-composer's /compose-and-respond expects. Caller fields are
    either camelCase or snake_case; output is camelCase only."""
    input_budget = int_limit(limits, "inputTokenBudget", "input_token_budget")
    max_context = int_limit(
        policy, "maxContextTokens", "max_context_tokens",
        default=input_budget or 8_000,
    )
    if input_budget:
        max_context = min(max_context or input_budget, input_budget)
    out = {
        "optimizationMode": str_value(
            policy, "optimizationMode", "optimization_mode", default="medium",
        ),
        "maxContextTokens": max_context,
        "compareWithRaw": bool(
            policy.get("compareWithRaw", policy.get("compare_with_raw", False)),
        ),
    }
    for snake, camel in [
        ("knowledge_top_k", "knowledgeTopK"),
        ("memory_top_k", "memoryTopK"),
        ("code_top_k", "codeTopK"),
        ("max_layer_chars", "maxLayerChars"),
        ("max_prompt_chars", "maxPromptChars"),
    ]:
        value = int_limit(policy, camel, snake)
        if value is not None:
            out[camel] = value
    return out


async def compile_execute_context(
    session_id: str,
    agent_id: Optional[str],
    user_message: str,
    system_prompt: Optional[str],
    context_policy: dict[str, Any],
    model_overrides: dict[str, Any],
    limits: dict[str, Any],
) -> tuple[list[dict], str, Optional[str], dict[str, Any], list[str]]:
    """Return MCP history/message/systemPrompt from context-memory compile.

    The MCP invoke endpoint appends `message` after `history`, so we pass
    all compiled messages except the final user message as history. The
    compiled system prompt stays inside history; `systemPrompt` is set to
    None to avoid duplicating the assembled prompt.

    Returns: (history_messages, user_message, system_prompt, optimization, warnings)
    """
    max_chars = int_limit(limits, "maxPromptChars", "max_prompt_chars")
    input_budget = int_limit(limits, "inputTokenBudget", "input_token_budget")
    max_context = int_limit(
        context_policy, "maxContextTokens", "max_context_tokens",
        default=input_budget or 8_000,
    )
    if input_budget:
        max_context = min(max_context or input_budget, input_budget)

    payload = {
        "session_id": session_id,
        "agent_id": agent_id,
        "user_message": user_message,
        "optimization_mode": str_value(
            context_policy, "optimizationMode", "optimization_mode", default="medium",
        ),
        "compare_with_raw": bool(
            context_policy.get("compareWithRaw", context_policy.get("compare_with_raw", False)),
        ),
        "max_context_tokens": max_context,
        "provider": str_value(model_overrides, "provider", default="gateway"),
        "model": (
            str_value(model_overrides, "model")
            or str_value(model_overrides, "modelAlias", "model_alias", default="gateway-default")
        ),
        "system_prompt": trim_text(system_prompt or "", max_chars) if system_prompt else None,
    }
    compiled = await _post(
        f"{settings.context_memory_url.rstrip('/')}/context/compile",
        payload,
        timeout=context_compile_timeout_sec(),
    )
    messages = [
        {"role": m.get("role"), "content": trim_text(str(m.get("content") or ""), max_chars)}
        for m in compiled.get("messages", [])
        if m.get("role") in ("system", "user", "assistant", "tool")
    ]
    max_history = int_limit(limits, "maxHistoryMessages", "max_history_messages")
    if max_history:
        system_messages = [m for m in messages if m["role"] == "system"]
        other_messages = [m for m in messages if m["role"] != "system"]
        if len(other_messages) > max_history:
            messages = system_messages + other_messages[-max_history:]
    if not messages:
        return (
            [],
            trim_text(user_message, max_chars),
            system_prompt,
            {},
            ["context compiler returned no messages"],
        )
    last = messages[-1]
    if last["role"] == "user":
        return (
            messages[:-1],
            last["content"],
            None,
            compiled.get("optimization") or {},
            [],
        )
    return (
        messages,
        trim_text(user_message, max_chars),
        None,
        compiled.get("optimization") or {},
        [],
    )
