"""
M71 — Loads StagePolicy from prompt-composer.

Calls `POST /api/v1/stage-policies/resolve` and caches the result for a TTL
(default 5 minutes). The cache key is `(stage_key, agent_role)`; we DON'T
key by phase because callers want the full per-phase fan-out so they can
make multiple per-turn checks without round-tripping.

Pattern mirrors `world_model_loader.py` in this same package:
    * httpx.AsyncClient with a service token
    * lazy module-level cache
    * `clear_cache()` for test isolation
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .phase_state import Phase

log = logging.getLogger(__name__)


# Environment knobs:
#   PROMPT_COMPOSER_URL           — base URL (defaults to compose-internal name)
#   STAGE_POLICY_CACHE_TTL_SEC    — TTL for the in-process cache (default 300s)
#   STAGE_POLICY_HTTP_TIMEOUT_SEC — outbound timeout (default 10s)
_COMPOSER_URL = os.environ.get("PROMPT_COMPOSER_URL", "http://prompt-composer:3004").rstrip("/")
_CACHE_TTL_SEC = float(os.environ.get("STAGE_POLICY_CACHE_TTL_SEC", "300"))
_HTTP_TIMEOUT = float(os.environ.get("STAGE_POLICY_HTTP_TIMEOUT_SEC", "10"))


class PolicyNotFoundError(LookupError):
    """Raised when prompt-composer has no StagePolicy for (stage_key, role)."""


@dataclass(frozen=True)
class PhasePolicy:
    """Decoded per-phase policy. Built from the prompt-composer response."""

    phase: Phase
    allowed_tools: frozenset[str]
    forbidden_tools: frozenset[str]
    required_output_schema: dict[str, Any]
    max_input_tokens: int | None
    max_output_tokens: int | None
    max_tool_calls: int | None


@dataclass(frozen=True)
class StagePolicy:
    """Decoded full stage policy. Single source of truth for one /execute call."""

    policy_id: str
    stage_key: str
    agent_role: str | None
    version: int
    status: str
    approval_model: dict[str, Any]
    limits: dict[str, Any]
    context_policy: dict[str, Any]
    edit_policy: dict[str, Any]
    verification_policy: dict[str, Any]
    risk_policy: dict[str, Any]
    phases: dict[Phase, PhasePolicy] = field(default_factory=dict)

    @property
    def max_repair_attempts(self) -> int:
        """Convenience read of the limits field used by the phase machine."""
        return int(self.limits.get("max_repair_attempts", 3))

    @property
    def max_plan_rewinds(self) -> int:
        """M73-followup #5 — cap on EXPLORE→PLAN re-routes. Symmetric to
        max_repair_attempts. Default 2 means the agent can do
        PLAN → EXPLORE → PLAN → EXPLORE → PLAN → EXPLORE → ACT (initial PLAN
        + 2 reroutes) before having to commit to ACT. A pathological agent
        without this cap can burn the entire turn budget oscillating between
        PLAN and EXPLORE."""
        return int(self.limits.get("max_plan_rewinds", 2))


# Module-level cache: key = (stage_key, agent_role|None), value = (expires_at, StagePolicy)
_cache: dict[tuple[str, str | None], tuple[float, StagePolicy]] = {}


def clear_cache() -> None:
    """Drop the in-process cache. Used by tests + admin endpoints."""
    _cache.clear()


def _phase_from_dict(payload: dict[str, Any]) -> PhasePolicy:
    phase_name = str(payload.get("phase", ""))
    try:
        phase = Phase(phase_name)
    except ValueError as exc:
        raise ValueError(f"unknown phase '{phase_name}' in StagePolicy payload") from exc
    return PhasePolicy(
        phase=phase,
        allowed_tools=frozenset(payload.get("allowedTools") or []),
        forbidden_tools=frozenset(payload.get("forbiddenTools") or []),
        required_output_schema=dict(payload.get("requiredOutputSchema") or {}),
        max_input_tokens=payload.get("maxInputTokens"),
        max_output_tokens=payload.get("maxOutputTokens"),
        max_tool_calls=payload.get("maxToolCalls"),
    )


def _stage_from_dict(payload: dict[str, Any]) -> StagePolicy:
    phases_list = payload.get("phases") or []
    phases_map: dict[Phase, PhasePolicy] = {}
    for entry in phases_list:
        decoded = _phase_from_dict(entry)
        phases_map[decoded.phase] = decoded
    return StagePolicy(
        policy_id=str(payload.get("policyId", "")),
        stage_key=str(payload.get("stageKey", "")),
        agent_role=payload.get("agentRole"),
        version=int(payload.get("version", 1)),
        status=str(payload.get("status", "ACTIVE")),
        approval_model=dict(payload.get("approvalModel") or {}),
        limits=dict(payload.get("limits") or {}),
        context_policy=dict(payload.get("contextPolicy") or {}),
        edit_policy=dict(payload.get("editPolicy") or {}),
        verification_policy=dict(payload.get("verificationPolicy") or {}),
        risk_policy=dict(payload.get("riskPolicy") or {}),
        phases=phases_map,
    )


async def load_stage_policy(
    stage_key: str,
    agent_role: str | None = None,
    *,
    bearer: str | None = None,
) -> StagePolicy:
    """Resolve a StagePolicy by (stage_key, agent_role).

    Uses an in-process TTL cache. Cache misses go to
    `POST /api/v1/stage-policies/resolve` on prompt-composer.

    Raises:
      PolicyNotFoundError when prompt-composer returns 404.
      RuntimeError on 5xx / network.

    The `bearer` parameter is the caller's auth token; we forward it so
    prompt-composer's auth middleware can attribute the call. If absent
    we omit the header (prompt-composer has AUTH_OPTIONAL in dev).
    """
    cache_key = (stage_key, agent_role)
    now = time.time()
    hit = _cache.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    url = f"{_COMPOSER_URL}/api/v1/stage-policies/resolve"
    headers = {"content-type": "application/json"}
    composer_bearer = (
        bearer
        or os.environ.get("PROMPT_COMPOSER_SERVICE_TOKEN")
        or os.environ.get("CONTEXT_FABRIC_SERVICE_TOKEN")
    )
    if composer_bearer:
        headers["authorization"] = f"Bearer {composer_bearer}"
    body: dict[str, Any] = {"stageKey": stage_key}
    if agent_role:
        body["agentRole"] = agent_role

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"prompt-composer unreachable: {exc}") from exc

    if response.status_code == 404:
        raise PolicyNotFoundError(
            f"No StagePolicy for stage_key={stage_key!r} agent_role={agent_role!r}"
        )
    if response.status_code >= 500:
        raise RuntimeError(
            f"prompt-composer 5xx loading StagePolicy: {response.status_code} {response.text[:200]}"
        )
    if response.status_code >= 400:
        raise RuntimeError(
            f"prompt-composer {response.status_code} loading StagePolicy: {response.text[:200]}"
        )

    payload = response.json()
    if not payload.get("success"):
        raise RuntimeError(f"prompt-composer returned success=false: {payload.get('error')}")
    policy = _stage_from_dict(payload.get("data") or {})
    _cache[cache_key] = (now + _CACHE_TTL_SEC, policy)
    log.info(
        "loaded StagePolicy stage_key=%s role=%s phases=%d policy_id=%s",
        stage_key,
        agent_role,
        len(policy.phases),
        policy.policy_id,
    )
    return policy
