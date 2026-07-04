"""
M73 — shared-HTTP MCP dispatch + error classification.

This module is the WHERE-to-POST and the WHAT-DOES-THE-ERROR-MEAN for
the legacy ``/execute`` path. The agent loop runs inside mcp-server; we
just hand it the assembled invoke payload and translate its responses.

Two functions:

  dispatch_invoke(...) → dict
      Thin httpx.post wrapper around ``POST {base}/mcp/invoke``. Raises
      ``httpx.HTTPStatusError`` on non-2xx — the orchestrator turns
      those into structured HTTP responses using ``classify_invoke_error``.

  classify_invoke_error(detail) → tuple[Optional[str], dict | str]
      Pure function. Inspects the mcp-server error envelope and
      decides whether to surface the inner LLM-gateway error code
      (LLM_PROVIDER_OVERLOADED / LLM_GATEWAY_TIMEOUT / ...) or collapse
      to the generic ``MCP_INVOKE_FAILED``. Workbench's retry/send-back
      copy varies on the code, so the passthrough matters.

The /mcp/resume continuation has the same wire shape so it shares
``dispatch_invoke``'s plumbing via ``dispatch_resume``.

Note: mcp-server's ``POST /mcp/invoke`` is the LEGACY path and returns
410 after the M71 hard cutover. This module is here to support the
``/execute`` route while it still exists; the new
``/execute-governed-stage`` route uses ``app.governed.dispatch`` instead,
which has a different error-classification contract (it raises typed
``ContextFabricToolError`` rather than ``HTTPStatusError``).
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..response_json import response_json_object


# Error codes from llm-gateway that mcp-server forwards verbatim. Workbench
# surfaces these with retry-specific copy ("Provider overloaded — retry
# in a minute" vs the generic MCP_INVOKE_FAILED "Send back to an earlier
# stage"). Keep this set in sync with mcp-server's llm-gateway-client
# error classifier and the workbench's retry-copy switch.
PASSTHROUGH_INNER_CODES: set[str] = {
    "LLM_PROVIDER_OVERLOADED",
    "LLM_PROVIDER_UNAVAILABLE",
    "LLM_PROVIDER_RATE_LIMITED",
    "LLM_GATEWAY_TIMEOUT",
    "LLM_GATEWAY_UNREACHABLE",
}


async def dispatch_invoke(
    *,
    mcp_base_url: str,
    mcp_bearer: str,
    payload: dict[str, Any],
    timeout_sec: float,
) -> dict[str, Any]:
    """POST ``{mcp_base_url}/mcp/invoke`` with the bearer token.

    Returns the parsed JSON body on 2xx. Raises ``httpx.HTTPStatusError``
    on any non-2xx so the orchestrator can decide whether to persist a
    FAILED call_log row + translate to its own HTTP code.
    """
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.post(
            f"{mcp_base_url.rstrip('/')}/mcp/invoke",
            json=payload,
            headers={"Authorization": f"Bearer {mcp_bearer}"},
        )
        resp.raise_for_status()
        return response_json_object(resp, "MCP invoke")


async def dispatch_resume(
    *,
    mcp_base_url: str,
    mcp_bearer: str,
    payload: dict[str, Any],
    timeout_sec: float,
) -> dict[str, Any]:
    """Sibling of ``dispatch_invoke`` for the /mcp/resume continuation
    path used after a human-approval pause. Identical plumbing; the
    payload shape differs (continuation_token instead of message)."""
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.post(
            f"{mcp_base_url.rstrip('/')}/mcp/resume",
            json=payload,
            headers={"Authorization": f"Bearer {mcp_bearer}"},
        )
        resp.raise_for_status()
        return response_json_object(resp, "MCP resume")


def classify_invoke_error(
    detail: dict[str, Any] | str,
) -> tuple[Optional[str], Optional[str]]:
    """Inspect a non-2xx body from /mcp/invoke and decide what code to
    raise it as. Pure function — no I/O.

    Returns ``(passthrough_code, message)``:

      * If ``detail`` carries one of ``PASSTHROUGH_INNER_CODES`` under
        ``detail.error.code``, returns ``("LLM_PROVIDER_OVERLOADED", "...")``
        (or whichever code) so the orchestrator surfaces it unchanged.
      * Otherwise returns ``(None, None)`` and the orchestrator falls
        back to its generic ``MCP_INVOKE_FAILED`` envelope.

    The orchestrator still owns: HTTP status code (passed through from
    the original response), call_log persistence, subscriber teardown.
    """
    if not isinstance(detail, dict):
        return None, None
    err = detail.get("error") or {}
    if not isinstance(err, dict):
        return None, None
    code = err.get("code")
    if not isinstance(code, str) or code not in PASSTHROUGH_INNER_CODES:
        return None, None
    message = err.get("message")
    return code, (message if isinstance(message, str) else None)
