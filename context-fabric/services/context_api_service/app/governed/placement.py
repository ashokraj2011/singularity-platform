"""
Placement policy — runtime bridge vs debug HTTP for MCP (tools) and LLM.

The control plane is always cloud. Only MCP and LLM have variable placement:
  • Enterprise override: ENTERPRISE_LLM_GATEWAY=true forces BOTH to debug HTTP.
  • Otherwise per-run flags can force HTTP with prefer_laptop=false or
    prefer_laptop_llm=false. The normal path is the Context Fabric runtime
    bridge. Whether a user or tenant runtime is actually connected is checked at
    dispatch time.

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
    """Return the user_id whose runtime should serve LLM for this run, else None.

    None (→ cloud gateway) unless ALL hold:
      • not enterprise_mode()
      • run did not explicitly opt out with prefer_laptop_llm=false
      • run_context carries a user_id

    Whether that runtime is connected and advertises 'model-run' is verified at
    dispatch time. HTTP fallback is controlled by RUNTIME_HTTP_FALLBACK_ENABLED.
    """
    if enterprise_mode():
        return None
    rc = run_context or {}
    if rc.get("prefer_laptop_llm") is False:
        return None
    if not _env_prefer_laptop_llm() and rc.get("prefer_laptop") is False:
        return None
    uid = rc.get("user_id") or rc.get("userId")
    return str(uid) if uid else None


def mcp_laptop_target(run_context: dict[str, Any] | None) -> str | None:
    """Return the user_id whose runtime should serve MCP operations, else None.

    ``prefer_laptop`` is now a compatibility knob:
      • False → force HTTP/debug path
      • True/None → prefer runtime bridge

    Whether the runtime is connected and advertises the required frame is
    verified at dispatch time.
    """
    if enterprise_mode():
        return None
    rc = run_context or {}
    if rc.get("prefer_laptop") is False:
        return None
    uid = rc.get("user_id") or rc.get("userId")
    return str(uid) if uid else None


def runtime_tenant_target(run_context: dict[str, Any] | None) -> str | None:
    """Return the tenant id used for shared runtime fallback."""
    rc = run_context or {}
    if enterprise_mode() or rc.get("prefer_laptop") is False:
        return None
    tenant_id = rc.get("tenant_id") or rc.get("tenantId") or rc.get("org_id") or rc.get("orgId")
    return str(tenant_id) if tenant_id else None


def runtime_capability_tags(run_context: dict[str, Any] | None) -> list[str]:
    """Return explicit runtime-placement tags.

    Do not derive these from the business ``capability_id``. Runtime tags are
    an operator placement filter (for example ``llm`` or ``tools``); a
    capability id is a governed SDLC/work domain. Treating every capability id
    as a runtime tag makes a healthy generic MCP runtime look disconnected
    unless its token was minted with every possible business capability.
    """
    rc = run_context or {}
    raw = (
        rc.get("runtime_capability_tags")
        or rc.get("runtimeCapabilityTags")
        # Back-compat for earlier clients that used capability_tags for
        # runtime placement rather than business capability metadata.
        or rc.get("capability_tags")
        or rc.get("capabilityTags")
    )
    if not isinstance(raw, list):
        return []
    tags: list[str] = []
    seen: set[str] = set()
    for tag in raw:
        value = str(tag).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        tags.append(value)
    return tags
