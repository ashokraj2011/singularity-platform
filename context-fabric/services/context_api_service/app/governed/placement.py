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


def llm_laptop_target(run_context: dict[str, Any] | None) -> str | None:
    """Return the user_id whose laptop should serve LLM for this run, else None.

    None (→ cloud gateway) unless ALL hold:
      • not enterprise_mode()
      • run_context["prefer_laptop_llm"] is truthy
      • run_context carries a user_id

    Whether that user's laptop is actually connected and advertises the
    'model-run' frame is verified at dispatch time (call_gateway_chat falls
    back to the cloud gateway if not), so this never hard-fails a run.
    """
    if not run_context or enterprise_mode():
        return None
    if not run_context.get("prefer_laptop_llm"):
        return None
    uid = run_context.get("user_id") or run_context.get("userId")
    return str(uid) if uid else None
