"""
World-model grounding for the governed-stage loop.

`WORKGRAPH_FORCE_GOVERNED_CODING` defaults true, so most coding AGENT_TASK nodes
run through `execute-governed-stage`. That path resolves a phase prompt template
via prompt-composer's `/stage-prompts/resolve` -- a template lookup, not a full
compose -- so it never received the capability world model or the layered role
views. The agents doing the most code work were the ones with the least grounding.

This injects the slice directly rather than routing the stage loop through a full
compose. That is a deliberately smaller step: the governed loop already owns its
message construction, its tool descriptors and its phase state, and rebuilding
all of that on top of compose-and-respond would be a rewrite with a much larger
blast radius than the grounding it is trying to deliver.

OFF by default (`CF_GOVERNED_STAGE_GROUNDING`). Adding grounding changes coding
agents' prompts, and therefore their output. Same posture as the single-turn
compose rollout: the flag exists so that lands deliberately.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("context_fabric.stage_grounding")

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}

# The governed loop's system message already carries stage rules, tool contracts
# and phase instructions. Grounding is context, not instruction, so it is capped
# well below those: a world model that crowds out the phase prompt has made the
# agent worse, not better.
MAX_GROUNDING_CHARS = 12_000


def stage_grounding_enabled() -> bool:
    """ON by default. Set CF_GOVERNED_STAGE_GROUNDING to a falsy value to revert.

    Coding agents are the ones that most need to know the build system, the test
    commands and the shape of the repository. Leaving this off was the last place
    the layered world model did not reach.

    Read per call, so reverting is an env change rather than a redeploy.
    """
    raw = os.getenv("CF_GOVERNED_STAGE_GROUNDING", "").strip().lower()
    if not raw:
        return True
    return raw not in _FALSY


def render_grounding_block(
    world_model: Optional[dict[str, Any]],
    views: Optional[list[dict[str, Any]]],
    *,
    max_chars: int = MAX_GROUNDING_CHARS,
) -> Optional[str]:
    """
    Render the slice as one system-message section, or None when there is
    nothing worth adding.

    Views come first and the capability-wide model second. The views are already
    role-scoped and budgeted by agent-runtime, so they are the higher-signal half;
    if the cap bites, it should bite the generic model rather than the view chosen
    for this specific agent.
    """
    sections: list[str] = []

    for view in views or []:
        if not isinstance(view, dict):
            continue
        body = str(view.get("contentMd") or "").strip()
        if not body:
            continue
        kind = str(view.get("kind") or "view")
        domain_key = str(view.get("domainKey") or "")
        title = str(view.get("title") or kind)
        scope = f"{kind}: {domain_key}" if domain_key else kind
        stale_note = (
            "\n_Built against an earlier revision of the repository; may be out of date._"
            if view.get("stale")
            else ""
        )
        sections.append(f"### {title} [{scope}]{stale_note}\n\n{body}")

    if isinstance(world_model, dict):
        facts: list[str] = []
        if world_model.get("primaryLanguage"):
            facts.append(f"- Primary language: {world_model['primaryLanguage']}")
        if world_model.get("buildSystem"):
            facts.append(f"- Build system: {world_model['buildSystem']}")
        for label, key in (("Build", "buildCommands"), ("Test", "testCommands")):
            commands = world_model.get(key)
            if isinstance(commands, list) and commands:
                rendered = ", ".join(
                    f"`{c.get('cmd')}`" for c in commands if isinstance(c, dict) and c.get("cmd")
                )
                if rendered:
                    facts.append(f"- {label} commands: {rendered}")
        if world_model.get("readmeSummary"):
            facts.append(f"- Overview: {world_model['readmeSummary']}")
        if facts:
            sections.append("### Capability facts\n\n" + "\n".join(facts))

    if not sections:
        return None

    block = "## Capability grounding\n\n" + "\n\n".join(sections)
    if len(block) > max_chars:
        # Truncate on a line boundary so a section never ends mid-sentence and
        # reads as though the model simply stopped being told things.
        block = block[:max_chars].rsplit("\n", 1)[0] + "\n\n_(grounding truncated to fit the prompt budget)_"
    return block


async def fetch_stage_grounding(
    *,
    run_context: dict[str, Any] | None,
    agent_role: str | None,
    task: str | None = None,
) -> Optional[str]:
    """
    Fetch and render the role-scoped slice for a governed stage.

    Returns None whenever grounding is disabled, unavailable, or empty. NEVER
    raises: a stage that ran without grounding before must still run now, and a
    slow or missing agent-runtime must not fail a coding turn.
    """
    if not stage_grounding_enabled():
        return None

    rc = run_context if isinstance(run_context, dict) else {}
    capability_id = rc.get("capability_id") or rc.get("capabilityId")
    if not capability_id:
        return None

    try:
        from ..config import settings
        from ..execute_modules.prompt_context import fetch_capability_world_model_slice

        if not settings.agent_runtime_url:
            return None
        world_model, views, warning = await fetch_capability_world_model_slice(
            settings.agent_runtime_url,
            str(capability_id),
            settings.agent_runtime_world_model_slice_timeout_sec,
            role=agent_role or rc.get("agent_role") or rc.get("agentRole"),
            task=task,
        )
        if warning:
            logger.warning("stage_grounding.slice_degraded %s", warning)
        return render_grounding_block(world_model, views)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("stage_grounding.skipped %s", exc)
        return None
