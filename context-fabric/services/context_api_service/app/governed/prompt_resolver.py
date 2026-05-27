"""
M71 Slice C(b) — Per-phase prompt resolution client.

Calls prompt-composer's /api/v1/stage-prompts/resolve with the current
phase so the LLM sees a phase-specific prompt rather than a kitchen-sink
stage-level one. Mirrors `policy_loader.py` — async httpx + TTL cache,
fail-fast on 404, structured exception on 5xx.

Cache key includes the phase because the same (stage, role) tuple resolves
to a different prompt per phase. TTL stays short (default 60s) so prompt
engineering iteration doesn't require a service restart.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .phase_state import Phase

log = logging.getLogger(__name__)


_COMPOSER_URL = os.environ.get("PROMPT_COMPOSER_URL", "http://prompt-composer:3004").rstrip("/")
_CACHE_TTL_SEC = float(os.environ.get("STAGE_PROMPT_CACHE_TTL_SEC", "60"))
_HTTP_TIMEOUT = float(os.environ.get("STAGE_PROMPT_HTTP_TIMEOUT_SEC", "15"))


class PromptNotFoundError(LookupError):
    """prompt-composer returned 404 — no binding for this (stage, role, phase)."""


@dataclass(frozen=True)
class ResolvedPrompt:
    """The shape we need to construct an LLM call.

    `task` and `extra_context` are user-message content; `system_prompt_append`
    is the system-message fragment composed from the matched profile's
    AGENT_ROLE + TOOL_CONTRACT + OUTPUT_CONTRACT layers.

    `phase` will be None when a stage-level (fallback) binding matched, so
    the caller can log whether they got the phase-specific override or the
    default. Useful when debugging "why did the agent ignore my new prompt".
    """

    task: str
    system_prompt_append: str
    extra_context: str
    prompt_profile_id: str
    binding_id: str
    stage_key: str
    agent_role: str | None
    phase: str | None


# M93.F — Cache key is now (stage_key, agent_role, phase, profile_key)
# so workflows targeting different prompt profiles don't share cached
# prompts. profile_key=None matches the pre-M93.F resolver-ladder path.
_cache: dict[tuple[str, str | None, str | None, str | None], tuple[float, ResolvedPrompt]] = {}


def clear_cache() -> None:
    """Test helper + future admin-trigger hook for re-seed flows."""
    _cache.clear()


async def resolve_phase_prompt(
    *,
    stage_key: str,
    agent_role: str | None,
    phase: Phase | None,
    vars: dict[str, Any] | None = None,
    bearer: str | None = None,
    prompt_profile_key: str | None = None,
) -> ResolvedPrompt:
    """Fetch the rendered prompt for (stage_key, agent_role, phase).

    Falls back through prompt-composer's resolver ladder when no phase-
    specific binding exists; we don't replicate the ladder here. Caching
    skips the round-trip on repeat calls within the TTL.

    `vars` is the Mustache substitution context — pass {goal, stageLabel,
    capturedDecisions, ...} so the template renders meaningfully. Cache
    key DOES NOT include vars because the same template renders against
    different vars per turn; we cache the un-rendered binding lookup and
    re-render on each call. Wait — that's wrong, the resolver returns the
    RENDERED task. Cache key must include vars OR we skip the cache
    when vars are present. Pragmatic choice: skip the cache when vars are
    present (the common case), use it only for prompt-engineering inspection.

    M93.F (2026-05-27) — `prompt_profile_key` is the workflow's
    explicit pick of a StagePromptBinding by key (set on the WorkbenchStage
    via the designer). When present, prompt-composer bypasses its
    normal resolver ladder and binds the named profile directly
    (stage-prompts.service.ts:129). Optional — empty/None preserves the
    pre-M93.F resolver behaviour. The override is included in the
    cache key so workflows targeting different profiles don't collide
    in CF's local cache.
    """
    phase_str = phase.value if phase is not None else None
    # Normalise empty string → None so the cache key + payload stay tidy.
    profile_key = prompt_profile_key.strip() if isinstance(prompt_profile_key, str) else None
    if not profile_key:
        profile_key = None

    if not vars:
        cache_key = (stage_key, agent_role, phase_str, profile_key)
        now = time.time()
        hit = _cache.get(cache_key)
        if hit and hit[0] > now:
            return hit[1]

    url = f"{_COMPOSER_URL}/api/v1/stage-prompts/resolve"
    headers = {"content-type": "application/json"}
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"

    body: dict[str, Any] = {"stageKey": stage_key}
    if agent_role:
        body["agentRole"] = agent_role
    if phase_str:
        body["phase"] = phase_str
    if vars:
        body["vars"] = vars
    if profile_key:
        body["promptProfileKey"] = profile_key

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"prompt-composer unreachable: {exc}") from exc

    if response.status_code == 404:
        raise PromptNotFoundError(
            f"No StagePromptBinding for stage_key={stage_key!r} "
            f"agent_role={agent_role!r} phase={phase_str!r}"
        )
    if not response.is_success:
        raise RuntimeError(
            f"prompt-composer {response.status_code} resolving prompt: {response.text[:200]}"
        )

    payload = response.json()
    if not payload.get("success"):
        raise RuntimeError(f"prompt-composer returned success=false: {payload.get('error')}")

    data = payload.get("data") or {}
    resolved = ResolvedPrompt(
        task=str(data.get("task") or ""),
        system_prompt_append=str(data.get("systemPromptAppend") or ""),
        extra_context=str(data.get("extraContext") or ""),
        prompt_profile_id=str(data.get("promptProfileId") or ""),
        binding_id=str(data.get("bindingId") or ""),
        stage_key=str(data.get("stageKey") or stage_key),
        agent_role=data.get("agentRole"),
        phase=data.get("phase"),
    )

    if not vars:
        # M93.F — profile_key participates in the cache key so workflows
        # targeting different profile keys don't share cached prompts.
        _cache[(stage_key, agent_role, phase_str, profile_key)] = (time.time() + _CACHE_TTL_SEC, resolved)

    return resolved
