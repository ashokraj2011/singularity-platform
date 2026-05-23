"""
M73 — laptop-bridge dispatch.

TODO(M73-followup): extract from execute.py:1380..1700 (laptop_bridge
branch interleaved with the mcp_dispatcher path).

When req.prefer_laptop=True (or auto-prefer is enabled and the user has a
live WebSocket bridge to their laptop's mcp-server), the dispatch path
shifts from "POST to a shared HTTP mcp-server" to "send the same payload
through the laptop_bridge WS, wait for the reply".

Target shape:

  dispatch_via_laptop(user_id, payload) → InvokeResponse
      Pulls the user's active bridge connection from laptop_registry,
      sends a request frame, awaits the matching reply or
      MCP_NOT_CONNECTED / timeout. Falls back to the shared HTTP path
      when prefer_laptop=False AND no bridge is live (auto-prefer mode).

  should_prefer_laptop(req, user_id) → bool
      Reads prefer_laptop / settings.laptop_auto_prefer / live bridge
      presence.

Errors specific to this path:
  MCP_NOT_CONNECTED — user has prefer_laptop=True but no live bridge.
                      Refuse 503 with a clear "open the menu-bar app and
                      sign in" hint.
  LAPTOP_TIMEOUT    — bridge took too long. Caller decides whether to
                      retry on the shared path.

The bridge transport itself lives in laptop_bridge.py / laptop_registry.py
(siblings of execute.py). This module is just the dispatch wrapper that
the orchestrator picks instead of mcp_dispatcher when the bridge is
available.
"""
from __future__ import annotations
