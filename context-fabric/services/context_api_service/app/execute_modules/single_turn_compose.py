"""
Route the verbatim single-turn endpoint through prompt-composer.

`execute-governed-single-turn` was built to send a caller's prompt to the model
UNCHANGED — that was its whole point. Fourteen callers rely on it: planner,
synthesis agents, room-copilot, spec-gen, the board services, event-horizon,
discovery, reconciliation. Every one of them reaches an LLM without passing
through prompt-composer, so none of them receives mandatory platform layers,
capability grounding, or the layered world model.

This module composes that turn instead. The caller's own prompt does not lose:
its `system_prompt` rides as an EXECUTION_OVERRIDE layer, which the composer
ranks at priority 9999 — above everything it adds — so caller intent still wins.
What changes is that platform layers now surround it.

ROLLOUT. Off unless CF_SINGLE_TURN_COMPOSE is set, and any single caller can opt
out per request. This is the first change in the consolidation with real
behavioural blast radius: composed prompts differ from verbatim ones, so planner
and synthesis OUTPUTS will shift. The flag exists so that lands deliberately.

DEGRADATION. Composition is never allowed to fail a turn. Every failure path —
no template id, oversized prompt, composer down, malformed response — returns
None, and the caller falls back to the verbatim messages it would have sent
anyway. A turn that would have worked before still works.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from ..config import settings

logger = logging.getLogger("context_fabric.single_turn_compose")

# prompt-composer's layerOverrideSchema caps an override layer at 4000 chars.
# A caller whose system prompt exceeds that cannot be composed without silently
# dropping instructions, so it stays verbatim instead. Truncating a system prompt
# to fit is the one outcome worse than not composing at all.
MAX_OVERRIDE_LAYER_CHARS = 4_000

_TRUTHY = {"1", "true", "yes", "on"}


def single_turn_compose_enabled() -> bool:
    """Read per call so an operator can enable or revert without a restart."""
    return os.getenv("CF_SINGLE_TURN_COMPOSE", "").strip().lower() in _TRUTHY


def compose_opt_out(run_context: dict[str, Any]) -> bool:
    """Per-caller escape hatch for the transition.

    A caller that discovers composition breaks its output can set this and keep
    running while the layer set is fixed, instead of the whole rollout being
    reverted for everyone.
    """
    for key in ("compose_single_turn", "composeSingleTurn"):
        value = run_context.get(key)
        if isinstance(value, bool):
            return value is False
        if isinstance(value, str) and value.strip().lower() in {"false", "0", "no", "off"}:
            return True
    return False


def _rc(run_context: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = run_context.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def should_compose(run_context: dict[str, Any], system_prompt: str) -> tuple[bool, Optional[str]]:
    """
    Decide whether this turn can and should be composed.

    Returns (should_compose, reason_when_not). The reason is surfaced as a
    warning on the response so an operator can see WHY a turn stayed verbatim —
    silent non-composition would make the rollout impossible to verify.
    """
    if not single_turn_compose_enabled():
        return False, None  # not a warning: this is the default posture
    if compose_opt_out(run_context):
        return False, "single_turn_compose.skipped: caller opted out"
    if not settings.composer_url:
        return False, "single_turn_compose.skipped: composer_url is not configured"
    if not _rc(run_context, "agent_template_id", "agentTemplateId"):
        # The composer resolves layers, model and policy from the template; with
        # no template there is nothing to compose against.
        return False, "single_turn_compose.skipped: run_context has no agent_template_id"
    if len(system_prompt or "") > MAX_OVERRIDE_LAYER_CHARS:
        return False, (
            f"single_turn_compose.skipped: system_prompt is {len(system_prompt)} chars, "
            f"over the {MAX_OVERRIDE_LAYER_CHARS}-char override-layer cap; kept verbatim"
        )
    return True, None


def build_compose_payload(
    *,
    run_context: dict[str, Any],
    system_prompt: str,
    task: str,
    trace_id: str,
    model_overrides: Optional[dict[str, Any]],
    world_model: Optional[dict[str, Any]] = None,
    world_model_views: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """
    The compose request for a single turn.

    Deliberately narrower than the /execute payload: no tool descriptors and no
    code-context package, because a single turn has no tool loop to feed. What it
    does carry is the caller's prompt as a top-priority override plus whatever
    grounding the capability has — which is exactly what these callers were
    missing.
    """
    overrides: dict[str, Any] = {"additionalLayers": []}
    if system_prompt and system_prompt.strip():
        overrides["additionalLayers"].append(
            {"layerType": "EXECUTION_OVERRIDE", "content": system_prompt.strip()},
        )

    payload: dict[str, Any] = {
        "agentTemplateId": _rc(run_context, "agent_template_id", "agentTemplateId"),
        "capabilityId": _rc(run_context, "capability_id", "capabilityId"),
        "task": task,
        "workflowContext": {
            "instanceId": _rc(run_context, "workflow_instance_id", "workflowInstanceId") or trace_id,
            "nodeId": _rc(run_context, "workflow_node_id", "workflowNodeId") or "single-turn",
            "traceId": trace_id,
            "vars": {},
            "globals": {},
            "priorOutputs": {},
        },
        "artifacts": [],
        "overrides": overrides,
        "modelOverrides": model_overrides or {},
        # A single turn dispatches no tools, so discovery would spend a
        # tool-service round trip on descriptors nothing can call.
        "toolDiscovery": {"enabled": False, "riskMax": "low", "limit": 0},
    }
    if world_model:
        payload["worldModel"] = world_model
    if world_model_views:
        payload["worldModelViews"] = world_model_views
    return payload


def extract_composed_messages(
    composed: Any,
    *,
    fallback_task: str,
) -> tuple[Optional[list[dict[str, str]]], Optional[str], list[str]]:
    """
    Turn a compose-and-respond body into messages.

    Returns (messages, prompt_assembly_id, warnings). messages is None when the
    response is unusable, which sends the caller back to verbatim rather than
    forward with a half-composed prompt.
    """
    if not isinstance(composed, dict):
        return None, None, ["single_turn_compose.fallback: composer returned a non-object"]
    data = composed.get("data") if isinstance(composed.get("data"), dict) else composed
    assembled = data.get("assembled") if isinstance(data.get("assembled"), dict) else {}

    system_prompt = assembled.get("systemPrompt")
    user_message = assembled.get("message") or fallback_task

    if not isinstance(system_prompt, str) or not system_prompt.strip():
        # No system prompt means no layers were assembled — composing gained
        # nothing, and the verbatim path is strictly better than an empty one.
        return None, None, ["single_turn_compose.fallback: composer returned no system prompt"]

    messages: list[dict[str, str]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": str(user_message)},
    ]
    warnings = [str(w) for w in (data.get("warnings") or []) if w]
    prompt_assembly_id = data.get("promptAssemblyId")
    return messages, (str(prompt_assembly_id) if prompt_assembly_id else None), warnings
