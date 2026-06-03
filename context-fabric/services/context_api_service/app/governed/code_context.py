"""Code-context-package builder for the governed loop (gap #5, 2026-05-23).

Mirrors the legacy execute_modules.prompt_context.build_code_context_package
helper but takes the arguments the governed turn already has on hand —
task_text from vars + capability_id from run_context — rather than the
legacy ExecuteRequest shape. This keeps the governed path independent
of execute_modules.

Opt-in: only fires when policy.context_policy.include_code_context_package
is True. When omitted (the default for all existing policies) the
governed turn behaves exactly as it did before this module landed.

Best-effort transport:
  • Returns None when no context_package is built (any failure mode).
  • Emits a `governed.code_context_skipped` audit event with the
    operator-readable reason so dashboards see the degradation.
  • Never raises — the turn proceeds without the package and the
    agent uses whatever tools are in its phase allowlist instead.

The package itself is a dict with at minimum `context_package_id` and a
`packageMarkdown` (or `markdown` / `text` — mcp-server has flipped the
key name a few times; we tolerate all three). The governed turn injects
the markdown into the prompt vars under `code_context_package` so
prompt-composer's Mustache templates can render `{{code_context_package}}`
when the per-phase prompt opts in.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import httpx


_DEFAULT_TIMEOUT_SEC = 45.0  # AST indexing of medium repos lands under this
_DEFAULT_TOKEN_BUDGET = 7000  # matches the legacy default


async def build_code_context_for_governed_turn(
    *,
    task_text: str,
    capability_id: Optional[str],
    run_context: Optional[dict[str, Any]],
    mcp_base_url: Optional[str] = None,
    mcp_bearer: Optional[str] = None,
    timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
    max_token_budget: int = _DEFAULT_TOKEN_BUDGET,
    _http_post: Any = None,  # injection seam for tests
) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """POST to mcp-server's /mcp/code-context/build and return the
    package dict. Returns (None, reason) on any failure.

    Reason strings stay informative + auditable — they end up in
    governed.code_context_skipped payloads where operators read them
    to decide whether to upgrade mcp-server, raise the budget, or
    just accept the degradation.
    """
    if not task_text or not task_text.strip():
        return None, "code_context.skipped: empty task_text"

    base = (mcp_base_url or os.environ.get("MCP_SERVER_URL", "")).rstrip("/")
    if not base:
        return None, "code_context.skipped: MCP_SERVER_URL not configured"
    token = mcp_bearer or os.environ.get("MCP_BEARER_TOKEN", "")

    trace_id = None
    if isinstance(run_context, dict):
        trace_id = (
            run_context.get("trace_id")
            or run_context.get("traceId")
        )

    payload: dict[str, Any] = {
        "task_text": task_text,
        "max_token_budget": max_token_budget,
        "include_tests": True,
    }
    if capability_id:
        payload["capability_id"] = capability_id
    if trace_id:
        payload["trace_id"] = trace_id
    # Thread the governed run_context so mcp-server resolves the SAME
    # per-workitem worktree a normal tool dispatch uses (workItemCode /
    # branch / source_*), instead of indexing the base sandbox. The build
    # route reuses ToolRunSchema's run_context shape and ignores unknown
    # keys, so forwarding the dict verbatim is safe.
    if isinstance(run_context, dict):
        payload["run_context"] = run_context
        work_item_id = run_context.get("work_item_id") or run_context.get("workItemId")
        if work_item_id:
            payload["work_item_id"] = work_item_id

    url = f"{base}/mcp/code-context/build"
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"

    poster = _http_post or _default_post
    try:
        body = await poster(url, payload, headers, timeout_sec)
    except Exception as exc:  # noqa: BLE001 — best-effort telemetry
        return None, f"code_context.skipped: transport error {exc!s}"

    if not isinstance(body, dict):
        return None, f"code_context.skipped: non-dict response ({type(body).__name__})"
    if not body.get("success"):
        return None, f"code_context.skipped: backend success=false ({str(body)[:200]})"

    pkg = body.get("data")
    if not isinstance(pkg, dict):
        return None, "code_context.skipped: missing data block"
    if not pkg.get("context_package_id"):
        return None, "code_context.skipped: malformed response (no context_package_id)"
    return pkg, None


def package_markdown(pkg: dict[str, Any]) -> str:
    """Pull a renderable markdown string out of the package envelope.
    mcp-server has flipped this key between releases (packageMarkdown
    in early M52, then markdown, then text); tolerate all three so a
    backend upgrade doesn't silently empty the prompt.
    """
    if not isinstance(pkg, dict):
        return ""
    for key in ("packageMarkdown", "markdown", "text"):
        value = pkg.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


async def _default_post(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_sec: float,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()
