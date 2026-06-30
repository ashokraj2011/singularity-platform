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

# P0 #2 — clone-credential injection. broker_git_credential + _git_broker_enabled
# live in app.git_broker (NOT internal_mcp) specifically to avoid an import cycle:
# importing internal_mcp here would pull governed.__init__ → governed.turn →
# governed.code_context (this module) back in mid-import. git_broker only depends
# on app.config + app.iam_service_token, so it imports cleanly from here.
from ..git_broker import _git_broker_enabled, clone_credential_for_run


_DEFAULT_TIMEOUT_SEC = 45.0  # AST indexing of medium repos lands under this
_DEFAULT_TOKEN_BUDGET = 7000  # matches the legacy default
_TRUTHY = {"1", "true", "yes", "on"}


def _http_fallback_enabled() -> bool:
    return os.environ.get("RUNTIME_HTTP_FALLBACK_ENABLED", "false").strip().lower() in _TRUTHY


async def build_code_context_for_governed_turn(
    *,
    task_text: str,
    capability_id: Optional[str],
    run_context: Optional[dict[str, Any]],
    mcp_base_url: Optional[str] = None,
    mcp_bearer: Optional[str] = None,
    timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
    max_token_budget: int = _DEFAULT_TOKEN_BUDGET,
    context_policy: Optional[str] = None,  # stage MODE (CODE_EDIT/VERIFY_ONLY/…)
    laptop_user_id: Optional[str] = None,  # placement: build on this user's laptop
    runtime_tenant_id: Optional[str] = None,
    runtime_capability_tags: Optional[list[str]] = None,
    _http_post: Any = None,  # injection seam for tests
) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """Build a code-context package and return the package dict, or
    (None, reason) on any failure.

    Transport: when ``laptop_user_id`` or ``runtime_tenant_id`` is set the
    run is placed on a runtime, so the repo/worktree lives THERE — the build
    is dispatched over the ``code-context`` bridge frame to the runtime's
    mcp-server. If that runtime is unavailable, static HTTP fallback is used
    only when ``RUNTIME_HTTP_FALLBACK_ENABLED=true``. Identity-less legacy
    callers still use the static ``MCP_SERVER_URL`` best-effort path because
    there is no runtime identity to route. Both transports return the same
    ``{success, data}`` envelope, parsed by ``_parse_code_context_body``.

    Reason strings stay informative + auditable — they end up in
    governed.code_context_skipped payloads where operators read them
    to decide whether to upgrade mcp-server, raise the budget, or
    just accept the degradation.
    """
    if not task_text or not task_text.strip():
        return None, "code_context.skipped: empty task_text"

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
    if context_policy:
        # Stage context_policy MODE — lets mcp-server scope non-tool context
        # to match the tool allowlist philosophy (slice-scoping is a follow-up;
        # threaded now for observability + forward-compat).
        payload["context_policy"] = context_policy
    # Thread the governed run_context so mcp-server resolves the SAME
    # per-workitem worktree a normal tool dispatch uses (workItemCode /
    # branch / source_*), instead of indexing the base sandbox. The build
    # route reuses ToolRunSchema's run_context shape and ignores unknown
    # keys, so forwarding the dict verbatim is safe.
    clone_cred: Optional[dict[str, Any]] = None
    if isinstance(run_context, dict):
        # P0 #2 — private-repo clone credential injection. The base run_context
        # forwarded here stays CLEAN (no token); the brokered, short-lived,
        # repo-scoped READ credential is attached SHARED-ONLY: passed to the
        # code-context FRAME dispatch as clone_credential (the registry injects it
        # into run_context for a SHARED runtime only, NEVER a personal laptop —
        # Decision #3) and attached to the HTTP-fallback payload (the co-located
        # shared mcp). The mcp consumes it for the clone and strips it before any
        # audit/correlation. Brokered ONCE per run (memoized, shared with the
        # tool-run path). Off (default) or no credential ⇒ static GITHUB_TOKEN.
        rc_out = dict(run_context)
        payload["run_context"] = rc_out
        work_item_id = rc_out.get("work_item_id") or rc_out.get("workItemId")
        if work_item_id:
            payload["work_item_id"] = work_item_id
        if _git_broker_enabled() and (rc_out.get("sourceUri") or rc_out.get("source_uri")):
            clone_cred = await clone_credential_for_run(rc_out)

    # Laptop bridge first: when the run is placed on the user's laptop the
    # repo/worktree lives THERE, not in the box's shared mcp-server sandbox.
    # Dispatch the build over the `code-context` frame so the world model is
    # indexed against the same laptop worktree the run's tools use. If a
    # runtime was requested, static HTTP is a debug fallback only; identity-less
    # legacy calls still use the HTTP path below. Mirrors the tool-dispatch
    # (governed.dispatch) and model-run (governed.llm_client) bridge paths.
    runtime_requested = bool(laptop_user_id or runtime_tenant_id)
    if runtime_requested:
        body = await _try_laptop_code_context(
            laptop_user_id or "",
            payload,
            timeout_sec,
            tenant_id=runtime_tenant_id,
            capability_tags=runtime_capability_tags,
            clone_credential=clone_cred,
        )
        if body is not None:
            return _parse_code_context_body(body)
        if not _http_fallback_enabled():
            return None, "RUNTIME_NOT_CONNECTED: no runtime bridge connected for code-context"

    base = (mcp_base_url or os.environ.get("MCP_SERVER_URL", "")).rstrip("/")
    if not base:
        return None, "code_context.skipped: MCP_SERVER_URL not configured"
    token = mcp_bearer or os.environ.get("MCP_BEARER_TOKEN", "")

    url = f"{base}/mcp/code-context/build"
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"

    # HTTP fallback targets the co-located/shared mcp-server, so attach the clone
    # credential directly (no laptop on this path). Built on a copy; the base
    # payload stays clean.
    http_payload = payload
    if clone_cred and isinstance(payload.get("run_context"), dict):
        http_payload = {**payload, "run_context": {**payload["run_context"], "gitCloneCredential": clone_cred}}
    poster = _http_post or _default_post
    try:
        body = await poster(url, http_payload, headers, timeout_sec)
    except Exception as exc:  # noqa: BLE001 — best-effort telemetry
        return None, f"code_context.skipped: transport error {exc!s}"

    return _parse_code_context_body(body)


def _parse_code_context_body(
    body: Any,
) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    """Validate a /mcp/code-context/build response envelope (same
    ``{success, data}`` shape over both HTTP and the laptop bridge) and pull
    out the package dict. Returns (pkg, None) on success, (None, reason)
    otherwise."""
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


async def _try_laptop_code_context(
    user_id: str,
    payload: dict[str, Any],
    timeout_sec: float,
    *,
    tenant_id: str | None = None,
    capability_tags: list[str] | None = None,
    clone_credential: dict[str, Any] | None = None,
) -> Optional[dict[str, Any]]:
    """Dispatch the code-context build over the laptop bridge. Returns the
    response envelope dict on success, or None to signal the caller should
    fall back to the static HTTP mcp-server path (no laptop connected /
    serving the frame, or any transport error — code-context is best-effort
    and must never raise out of the governed turn).
    """
    # Lazy import — keep the WebSocket registry stack out of this module's
    # import graph (mirrors governed.dispatch._dispatch_via_laptop).
    try:
        from ..laptop_registry import (
            REGISTRY,
            LaptopInvokeError,
            LaptopInvokeTimeout,
            LaptopNotConnected,
            LaptopSendFailed,
        )
    except Exception:  # pragma: no cover — registry is always importable in-app
        return None
    try:
        return await REGISTRY.dispatch_code_context_via_laptop(
            user_id=user_id,
            tenant_id=tenant_id,
            capability_tags=capability_tags,
            request_body=payload,
            clone_credential=clone_credential,
            timeout=timeout_sec,
        )
    except (LaptopNotConnected, LaptopSendFailed, LaptopInvokeTimeout, LaptopInvokeError):
        return None
    except Exception:  # noqa: BLE001 — best-effort: any bridge error → HTTP path
        return None


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
