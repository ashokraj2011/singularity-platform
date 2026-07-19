"""
Task identity at the gateway.

The gateway has always known WHICH model a caller asked for and nothing about
WHY. Task identity lived inside context-fabric (phase aliases, run_context) and
never crossed the hop, so gateway logs could not answer the questions operators
actually ask: how much does planning cost, which subsystem is retrying, is that
embedding spend agent work or background distillation.

A tag is a coarse bucket. `stage` and `purpose` narrow it when the caller knows
more. Deliberately a small closed vocabulary — free-form tags would fragment into
a dozen spellings of the same thing and be useless for aggregation.

Rollout is optional-then-required: an untagged call warns today and 400s once
GATEWAY_REQUIRE_TASK_TAG is set, so callers can migrate without an outage.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("llm_gateway.task")

# The buckets. Every LLM egress on the platform falls into exactly one.
AGENT_TURN = "agent_turn"                    # a governed/composed agent turn
DIRECT_LLM_TASK = "direct_llm_task"          # a workflow node calling an LLM directly
WORLD_MODEL_DISTILL = "world_model_distill"  # capability grounding + view builds
CLAIM_LOWERING = "claim_lowering"            # claim-registry canonicalization
SUMMARISE = "summarise"                      # conversation/context summarisation
CAPSULE_COMPILE = "capsule_compile"          # context-capsule precompilation
JUDGE = "judge"                              # audit-gov LLM judging / diagnosis
EMBEDDING = "embedding"                      # vector embedding
PLANNING = "planning"                        # workflow/DAG planning
SYNTHESIS = "synthesis"                      # synthesis studio agents
DISCOVERY = "discovery"                      # repo/source discovery
HARNESS = "harness"                          # test harnesses and chaos tooling

KNOWN_TASK_TAGS = frozenset({
    AGENT_TURN,
    DIRECT_LLM_TASK,
    WORLD_MODEL_DISTILL,
    CLAIM_LOWERING,
    SUMMARISE,
    CAPSULE_COMPILE,
    JUDGE,
    EMBEDDING,
    PLANNING,
    SYNTHESIS,
    DISCOVERY,
    HARNESS,
})

_TRUTHY = {"1", "true", "yes", "on"}


def require_task_tag() -> bool:
    """Whether an untagged call is rejected. Read per-call so an operator can
    flip it without a restart, and so tests can toggle it."""
    return os.getenv("GATEWAY_REQUIRE_TASK_TAG", "").strip().lower() in _TRUTHY


def normalize_task_tag(raw: Optional[str]) -> Optional[str]:
    """Lower-case and dash-normalise. Returns None for blank input.

    An UNKNOWN tag is passed through rather than rejected: a new caller naming a
    genuinely new bucket should be visible in the logs, not blocked at the hop.
    The warning is what prompts adding it to the vocabulary here.
    """
    if not isinstance(raw, str):
        return None
    tag = raw.strip().lower().replace("-", "_").replace(" ", "_")
    return tag or None


def resolve_task_identity(req: Any, *, endpoint: str) -> dict[str, Optional[str]]:
    """
    Pull task identity off a request, warn about what is missing, and return the
    fields to log. Never raises for an unknown tag; raises only when a tag is
    absent and the gateway is configured to require one.
    """
    tag = normalize_task_tag(getattr(req, "task_tag", None))

    # Embeddings can self-identify: there is exactly one reason to call them, so
    # requiring the caller to say so adds friction without adding information.
    if tag is None and endpoint == "embeddings":
        tag = EMBEDDING

    if tag is None:
        if require_task_tag():
            from fastapi import HTTPException

            raise HTTPException(
                status_code=400,
                detail=(
                    "task_tag is required (GATEWAY_REQUIRE_TASK_TAG is set). "
                    f"Send one of: {', '.join(sorted(KNOWN_TASK_TAGS))}"
                ),
            )
        logger.warning(
            "llm_gateway.untagged_call endpoint=%s model_alias=%s capability_id=%s trace_id=%s",
            endpoint,
            getattr(req, "model_alias", None),
            getattr(req, "capability_id", None),
            getattr(req, "trace_id", None),
        )
    elif tag not in KNOWN_TASK_TAGS:
        logger.warning(
            "llm_gateway.unknown_task_tag tag=%s endpoint=%s model_alias=%s -- add it to task_tags.KNOWN_TASK_TAGS",
            tag,
            endpoint,
            getattr(req, "model_alias", None),
        )

    return {
        "task_tag": tag,
        "stage": normalize_task_tag(getattr(req, "stage", None)),
        "purpose": normalize_task_tag(getattr(req, "purpose", None)),
    }


def emit_call_audit(
    *,
    endpoint: str,
    identity: dict[str, Optional[str]],
    provider: str,
    model: str,
    model_alias: Optional[str],
    req: Any,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    estimated_cost: Optional[float] = None,
) -> None:
    """
    One structured line per gateway call, carrying task identity alongside cost.

    This IS the gateway's audit trail today — there is no separate sink — so it
    is emitted for every call including mock, and it never raises: an audit
    failure must not fail the call it is describing.
    """
    try:
        logger.info(
            "llm_gateway.call endpoint=%s task_tag=%s stage=%s purpose=%s provider=%s model=%s "
            "model_alias=%s capability_id=%s trace_id=%s run_id=%s "
            "input_tokens=%s output_tokens=%s estimated_cost=%s",
            endpoint,
            identity.get("task_tag") or "-",
            identity.get("stage") or "-",
            identity.get("purpose") or "-",
            provider,
            model,
            model_alias or "-",
            getattr(req, "capability_id", None) or "-",
            getattr(req, "trace_id", None) or "-",
            getattr(req, "run_id", None) or "-",
            input_tokens if input_tokens is not None else "-",
            output_tokens if output_tokens is not None else "-",
            f"{estimated_cost:.6f}" if isinstance(estimated_cost, (int, float)) else "-",
        )
    except Exception:  # pylint: disable=broad-except
        pass
