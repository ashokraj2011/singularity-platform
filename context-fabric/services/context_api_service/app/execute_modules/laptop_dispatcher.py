"""
M73 — laptop-bridge dispatch.

When the operator runs the menu-bar app and signs in, their laptop's
mcp-server connects to context-fabric via a WebSocket bridge. This
module owns the routing decision (is a laptop available? should we use
it?) and the actual invoke call through the bridge.

The error-to-HTTP translation (MCP_NOT_CONNECTED → 503,
MCP_LAPTOP_TIMEOUT → 504) stays in the orchestrator because it needs to
also tear down the live-events subscriber + write a FAILED call_log
row. That coupling is what the orchestrator.run() extraction will sort
out next.

Modes (driven by req.prefer_laptop):

  None  — auto-prefer. Use laptop when one is connected for this user,
          otherwise silently fall through to the shared HTTP path.
  True  — require laptop. If none is connected, the orchestrator
          refuses 503 MCP_NOT_CONNECTED with the "open the menu-bar
          app and sign in" hint.
  False — never laptop. Force the shared HTTP path even if a laptop
          is available (used for QA-stage runs that must hit the
          managed runtime).
"""
from __future__ import annotations

from typing import Any, Optional


async def resolve_laptop_target(
    *,
    user_id: Optional[str],
    prefer_laptop: Optional[bool],
) -> tuple[bool, Optional[str], Optional[str]]:
    """Decide whether this invoke should go via the user's laptop bridge.

    Returns ``(use_laptop, device_id, device_name)``:

      * ``use_laptop`` — True only when prefer_laptop != False AND a live
        bridge exists for this user.
      * ``device_id`` / ``device_name`` — populated only when use_laptop is
        True; used by the orchestrator to emit the cf.invoke.via_laptop
        audit event so Workgraph Run Insights can render the
        "🖥 served by your laptop" badge.

    Does NOT raise on "prefer_laptop=True but no bridge" — that branch
    needs orchestrator-level cleanup (subscriber teardown + FAILED
    call_log row) so the caller decides whether to refuse. Returning
    (False, None, None) here is the signal that nothing is connected.
    """
    if not user_id or prefer_laptop is False:
        return False, None, None
    # Lazy import — laptop_registry pulls in the websockets stack which
    # we don't want loaded for purely HTTP-mode deployments.
    from ..laptop_registry import REGISTRY
    conn = await REGISTRY.any_for_user(user_id)
    if conn is None:
        return False, None, None
    return True, conn.device_id, conn.device_name


async def dispatch_via_laptop(
    *,
    user_id: str,
    payload: dict[str, Any],
    timeout_sec: float,
) -> dict[str, Any]:
    """POST the invoke payload through the laptop WebSocket bridge.

    Returns the same dict shape mcp-server's HTTP /mcp/invoke returns
    (data/finalResponse/tokensUsed/...) so the orchestrator can treat
    laptop and HTTP results uniformly downstream.

    Raises (without wrapping):
      * ``LaptopInvokeTimeout`` — bridge took longer than ``timeout_sec``.
      * ``LaptopInvokeError(code, message, details)`` — bridge returned
        a structured error from the laptop's mcp-server (most often
        provider rate limits or workspace-permission denials).

    The orchestrator translates these into HTTP 504 / 502 with the
    MCP_LAPTOP_TIMEOUT / passthrough-code error envelope. We deliberately
    do NOT translate here so the laptop-only test path can assert the
    raw exception types.
    """
    from ..laptop_registry import REGISTRY
    return await REGISTRY.invoke(
        user_id=user_id,
        payload=payload,
        timeout=timeout_sec,
    )
