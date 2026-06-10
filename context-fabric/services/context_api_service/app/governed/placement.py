"""
Placement policy — cloud vs laptop for MCP (tools) and LLM (model), per run.

The control plane is always cloud. Only MCP and LLM have variable placement:
  • Enterprise override: ENTERPRISE_LLM_GATEWAY=true forces BOTH to cloud — the
    laptop is never dispatched to, even if the user has a paired laptop.
  • Otherwise per-run flags select laptop: prefer_laptop (MCP) and
    prefer_laptop_llm (LLM, carried in run_context). Whether the user's laptop
    is actually connected (and, for LLM, advertises the `model-run` frame) is
    checked at dispatch time — these helpers only decide *intent*.

See docs/deployment-topology.md.
"""
from __future__ import annotations

import os
from typing import Any

_TRUTHY = {"1", "true", "yes", "on"}


def enterprise_mode() -> bool:
    """True when an enterprise LLM gateway is mandated → force cloud for MCP+LLM.

    Set ENTERPRISE_LLM_GATEWAY=true in a deployment where the org runs the
    gateway centrally and laptop compute must never be used. Read at call time
    so it can't be stale.
    """
    return os.environ.get("ENTERPRISE_LLM_GATEWAY", "false").strip().lower() in _TRUTHY


def mcp_laptop_allowed(prefer_laptop: bool | None) -> bool | None:
    """Gate the MCP `prefer_laptop` signal through the enterprise override.

    Returns False (force the shared cloud mcp-server) in enterprise mode;
    otherwise passes `prefer_laptop` through unchanged (None = auto-prefer when
    connected, True = require laptop, False = force cloud).
    """
    if enterprise_mode():
        return False
    return prefer_laptop


def _env_prefer_laptop_llm() -> bool:
    """Deployment-wide opt-in for laptop LLM, independent of the per-run flag.

    Set PREFER_LAPTOP_LLM=true to route LLM to the launching user's laptop for
    every run (useful for testing, or a homogeneous BYO-laptop fleet). The
    enterprise override still wins, and a laptop must actually be connected +
    serving model-run or it falls back to the cloud gateway.
    """
    return os.environ.get("PREFER_LAPTOP_LLM", "false").strip().lower() in _TRUTHY


def llm_laptop_target(run_context: dict[str, Any] | None) -> str | None:
    """Return the user_id whose laptop should serve LLM for this run, else None.

    None (→ cloud gateway) unless ALL hold:
      • not enterprise_mode()
      • run opted in — either run_context["prefer_laptop_llm"] is truthy OR the
        deployment-wide PREFER_LAPTOP_LLM env is set
      • run_context carries a user_id

    Whether that user's laptop is actually connected and advertises the
    'model-run' frame is verified at dispatch time (call_gateway_chat falls
    back to the cloud gateway if not), so this never hard-fails a run.
    """
    if enterprise_mode():
        return None
    rc = run_context or {}
    if not (rc.get("prefer_laptop_llm") or _env_prefer_laptop_llm()):
        return None
    uid = rc.get("user_id") or rc.get("userId")
    return str(uid) if uid else None


def mcp_laptop_target(run_context: dict[str, Any] | None) -> str | None:
    """Return the user_id whose laptop should serve MCP operations (tools +
    code-context build) for this run, else None.

    Mirrors the tool-dispatch placement in governed.loop — ``prefer_laptop``
    is True and a user_id is present — with the enterprise override forcing
    cloud. Used by the code-context builder so the repo world model is indexed
    against the SAME laptop worktree the run's tools dispatch to, instead of
    the box's shared mcp-server sandbox.

    Whether that laptop is actually connected and advertises the
    'code-context' frame is verified at dispatch time (the builder falls back
    to the static MCP_SERVER_URL HTTP path if not), so this never hard-fails a
    run.
    """
    if enterprise_mode():
        return None
    rc = run_context or {}
    if rc.get("prefer_laptop") is not True:
        return None
    uid = rc.get("user_id") or rc.get("userId")
    return str(uid) if uid else None
