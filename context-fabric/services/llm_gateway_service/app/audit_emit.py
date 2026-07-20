"""
The gateway's cost emitter — `llm.call.completed` → audit-governance-service.

WHY THE GATEWAY. `audit_governance.llm_calls` has exactly the right columns and
is dead: its only real emitter was the pre-M71 agent loop
(mcp-server/src/mcp/invoke.ts), which is retired. Live traffic emits
governed.llm_request / governed.llm_response into audit_events instead, so no
live call has ever produced a cost row. The gateway is the ONE component that
sees every LLM egress on the platform — governed turns, direct workflow calls,
distillation, embeddings — so it is the only place an emitter can be complete.

WHY HTTP AND NOT A DIRECT DB WRITE. Three reasons, in order of weight:

  1. This service has ZERO database dependency today (see requirements.txt — no
     psycopg, no asyncpg — and no depends_on: postgres in its compose block).
     Adding one would put a brand-new failure mode on the hottest path in the
     platform.
  2. The gateway runs on laptops, which can reach an HTTPS endpoint but cannot
     reach cloud Postgres. HTTP emission is the only way laptop traffic ever
     becomes centrally visible.
  3. The pipe already exists and already fires inline:
     routes-events.ts → cost-worker.ts → llm_calls. It is dead only because
     nothing emits into it.

DURABILITY. At-most-once, deliberately. The retry queue below is in-process and
bounded; a gateway restart or a long audit-gov outage drops what is queued. A
durable outbox would mean a spool file or a database — i.e. exactly the
dependency point 1 says not to add. Cost telemetry is not a ledger of record;
losing a bounded window of it during an outage is the accepted price of keeping
the LLM path free of a second hard dependency. The `task_tags.emit_call_audit`
log line remains the last-resort record of every call including the dropped ones.

NEVER TEXT. Prompt and response bodies never enter this payload — hashes and
char counts only. llm_calls is queried in aggregate and this emitter fires on
every call; text here would put prompt bodies into a rollup table, and put them
on the wire to a service that does not need them.

NEVER RAISES. Every public function here swallows its own failures. A telemetry
failure must not fail the call it describes.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from collections import deque
from typing import Any, Deque, Dict, Optional

import httpx

log = logging.getLogger("llm_gateway.audit")

AUDIT_GOV_URL = os.environ.get("AUDIT_GOV_URL", "http://host.docker.internal:8500")
AUDIT_GOV_SERVICE_TOKEN = os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "")

SOURCE_SERVICE = "llm-gateway"
EVENT_KIND = "llm.call.completed"
# The gateway prices from its own per-alias catalog. audit-gov's rate_card is
# keyed (provider, model) and cannot express two aliases on one model priced
# differently, so the two can legitimately disagree — the row records which one
# produced cost_usd rather than leaving the disagreement mysterious.
PRICE_SOURCE = "gateway_catalog"

_TRUTHY = {"1", "true", "yes", "on"}


def _warn_config(name: str, raw: str, value: float, reason: str) -> None:
    log.warning("ignoring %s=%r; using %r (%s)", name, raw, value, reason)


def _bounded_float_env(name: str, default: float, *, min_value: float, max_value: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        _warn_config(name, raw, default, "expected number")
        return default
    if value < min_value:
        _warn_config(name, raw, default, f"minimum is {min_value}")
        return default
    if value > max_value:
        _warn_config(name, raw, max_value, f"maximum is {max_value}")
        return max_value
    return value


def _bounded_int_env(name: str, default: int, *, min_value: int, max_value: int) -> int:
    return int(_bounded_float_env(name, float(default), min_value=float(min_value), max_value=float(max_value)))


EMIT_TIMEOUT_SEC = _bounded_float_env(
    "GATEWAY_AUDIT_EMIT_TIMEOUT_SEC", 5.0, min_value=0.5, max_value=60.0,
)
# Bounded on purpose. This queue is the entire durability story: it absorbs a
# short audit-gov blip and nothing more. Sized so a sustained outage costs
# bounded memory instead of unbounded memory on the hottest service we run.
QUEUE_MAX = _bounded_int_env(
    "GATEWAY_AUDIT_EMIT_QUEUE_MAX", 1000, min_value=1, max_value=100_000,
)
MAX_ATTEMPTS = _bounded_int_env(
    "GATEWAY_AUDIT_EMIT_MAX_ATTEMPTS", 3, min_value=1, max_value=10,
)
RETRY_DELAY_SEC = _bounded_float_env(
    "GATEWAY_AUDIT_EMIT_RETRY_DELAY_SEC", 2.0, min_value=0.0, max_value=60.0,
)

# deque(maxlen=…) discards from the LEFT when full, i.e. the OLDEST pending
# event is what gets dropped under pressure. That is the right end to lose:
# newer cost data is the data an operator is looking at during an incident.
_queue: Deque[Dict[str, Any]] = deque(maxlen=QUEUE_MAX)
_drain_task: Optional["asyncio.Task[None]"] = None
_dropped = 0


def emit_enabled() -> bool:
    """Whether the emitter is switched on. DEFAULT FALSE.

    Read per-call, not captured at import, for the same reason
    task_tags.require_task_tag is: an operator can flip it without a restart,
    and a test can toggle it without reloading the module.

    DO NOT ENABLE THIS until AUDIT_GOV_REQUIRE_TENANT_SCOPE=enforce is set.
    The audit-gov query endpoints are fail-open on tenant today; they return
    nothing only because llm_calls is empty. Filling it with per-user cost and
    prompt hashes while those endpoints are still shadow-mode would start
    returning real cross-tenant data.
    """
    return os.getenv("GATEWAY_AUDIT_EMIT_ENABLED", "").strip().lower() in _TRUTHY


def sha256_text(text: Optional[str]) -> Optional[str]:
    """Hex sha256 of a string, or None. The ONLY thing derived from content
    that is allowed to leave this process."""
    if not isinstance(text, str) or not text:
        return None
    try:
        return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
    except Exception:  # pylint: disable=broad-except
        return None


def fingerprint(text: Optional[str]) -> tuple[Optional[str], Optional[int]]:
    """(sha256, char count) for one blob of content. The pair is the whole
    contract: enough for dedup, replay verification and cache analysis; not
    enough to reconstruct a single character of what was sent."""
    if not isinstance(text, str):
        return None, None
    return sha256_text(text), len(text)


def fingerprint_messages(messages: Any) -> tuple[Optional[str], Optional[int]]:
    """Fingerprint a chat request's messages.

    The HASH is over a role-tagged, separator-joined rendering, so that
    [("user","ab"), ("user","c")] and [("user","a"), ("user","bc")] do not
    collide — a fingerprint that ignored message boundaries would report two
    materially different prompts as the same one.

    The COUNT is content characters only, excluding the separators and role
    tags this function adds. Otherwise prompt_chars would drift from the actual
    prompt size by a per-message constant, and the column would quietly stop
    being comparable to response_chars.

    The joined text is a local: never logged, never transmitted. Only the hash
    and the count leave this function.
    """
    try:
        parts = []
        content_chars = 0
        for msg in messages or []:
            content = getattr(msg, "content", None)
            if content is None and isinstance(msg, dict):
                content = msg.get("content")
            role = getattr(msg, "role", None)
            if role is None and isinstance(msg, dict):
                role = msg.get("role")
            if isinstance(content, str):
                content_chars += len(content)
            parts.append(f"{role or ''}\x1f{content or ''}")
        if not parts:
            return None, None
        return sha256_text("\x1e".join(parts)), content_chars
    except Exception:  # pylint: disable=broad-except
        return None, None


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        out = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return out if out >= 0 else None


def build_event(
    *,
    gateway_call_id: str,
    endpoint: str,
    provider: str,
    model: str,
    model_alias: Optional[str] = None,
    identity: Optional[Dict[str, Optional[str]]] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    latency_ms: Optional[int] = None,
    finish_reason: Optional[str] = None,
    routing_source: Optional[str] = None,
    estimated_cost: Optional[float] = None,
    trace_id: Optional[str] = None,
    capability_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    run_id: Optional[str] = None,
    prompt_sha256: Optional[str] = None,
    response_sha256: Optional[str] = None,
    prompt_chars: Optional[int] = None,
    response_chars: Optional[int] = None,
) -> Dict[str, Any]:
    """Build the audit-gov event envelope + payload.

    The payload MUST satisfy `llmCallPayload` in audit-governance-service's
    src/types.ts. That schema is a silent gate — cost-worker.ts safeParses it
    and returns quietly on failure — so a field it does not declare is dropped
    without a word and a field of the wrong type takes the whole cost row with
    it. audit-governance-service/test/gateway-llm-call-payload.contract.test.ts
    parses the fixture this function produces against the real schema so a
    drift on either side fails a test instead of silently emitting nothing.

    NO PROMPT OR RESPONSE TEXT. Only sha256 + char counts.
    """
    ident = identity or {}
    in_tokens = _int_or_none(input_tokens) or 0
    out_tokens = _int_or_none(output_tokens) or 0

    payload: Dict[str, Any] = {
        "provider": provider,
        "model": model,
        "input_tokens": in_tokens,
        "output_tokens": out_tokens,
        "total_tokens": in_tokens + out_tokens,
        "endpoint": endpoint,
        "gateway_call_id": gateway_call_id,
    }

    def put(key: str, value: Any) -> None:
        if value is not None:
            payload[key] = value

    put("model_alias", model_alias)
    put("task_tag", ident.get("task_tag"))
    put("stage", ident.get("stage"))
    put("purpose", ident.get("purpose"))
    put("latency_ms", _int_or_none(latency_ms))
    put("finish_reason", finish_reason)
    put("routing_source", routing_source)
    # actor_id is ATTRIBUTION, NOT AUTHORIZATION — the gateway sits behind one
    # shared bearer, so any caller can claim any actor. Left absent rather than
    # defaulted so NULL keeps meaning "a caller did not propagate it" (the m75
    # convention) instead of blurring into "no human".
    put("actor_id", actor_id)
    # run_id has no llm_calls column, so llmCallPayload strips it out of the
    # cost row — but it is NOT dead weight: cost-worker's savings denormaliser
    # reads run_id off the RAW payload as its session_id fallback, and the whole
    # payload is retained on audit_events.payload regardless.
    put("run_id", run_id)
    if isinstance(estimated_cost, (int, float)) and not isinstance(estimated_cost, bool):
        if estimated_cost >= 0:
            payload["cost_usd"] = float(estimated_cost)
            payload["price_source"] = PRICE_SOURCE
    put("prompt_sha256", prompt_sha256)
    put("response_sha256", response_sha256)
    put("prompt_chars", _int_or_none(prompt_chars))
    put("response_chars", _int_or_none(response_chars))

    body: Dict[str, Any] = {
        "source_service": SOURCE_SERVICE,
        "kind": EVENT_KIND,
        "severity": "info",
        # subject is the call itself, so the audit_events row and the llm_calls
        # row share the exact join key rather than being matched by timestamp.
        "subject_type": "llm_call",
        "subject_id": gateway_call_id,
        "payload": payload,
    }
    if trace_id:
        body["trace_id"] = trace_id
    if capability_id:
        body["capability_id"] = capability_id
    if tenant_id:
        body["tenant_id"] = tenant_id
    if actor_id:
        body["actor_id"] = actor_id
    return body


async def _post(body: Dict[str, Any]) -> bool:
    """POST one event. Returns True on acceptance. Never raises.

    4xx other than 429 is NOT retried: a rejected shape will be rejected
    identically forever, and retrying it just burns the queue on an event that
    can never land.
    """
    url = AUDIT_GOV_URL.rstrip("/") + "/api/v1/events"
    headers = {}
    if AUDIT_GOV_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {AUDIT_GOV_SERVICE_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=EMIT_TIMEOUT_SEC) as client:
            res = await client.post(url, json=body, headers=headers)
            if res.status_code < 400:
                return True
            if 400 <= res.status_code < 500 and res.status_code != 429:
                log.warning(
                    "audit emit rejected %s -> %s: %s (not retrying)",
                    EVENT_KIND, res.status_code, res.text[:200],
                )
                return True  # terminal: drop it rather than retry forever
            log.warning("audit emit %s -> %s", EVENT_KIND, res.status_code)
            return False
    except Exception as err:  # pylint: disable=broad-except
        log.warning("audit emit %s failed: %s", EVENT_KIND, err)
        return False


async def _drain() -> None:
    """Drain the retry queue. Never raises; always clears _drain_task."""
    global _drain_task  # pylint: disable=global-statement
    try:
        while _queue:
            item = _queue.popleft()
            ok = await _post(item["body"])
            if ok:
                continue
            item["attempts"] = item.get("attempts", 0) + 1
            if item["attempts"] >= MAX_ATTEMPTS:
                log.warning(
                    "audit emit dropping event after %s attempts (call_id=%s)",
                    item["attempts"], item.get("call_id"),
                )
                continue
            # Re-queue at the BACK so one unlucky event cannot head-of-line
            # block the rest, and pause so a hard outage does not spin.
            _queue.append(item)
            if RETRY_DELAY_SEC > 0:
                await asyncio.sleep(RETRY_DELAY_SEC)
    except Exception as err:  # pylint: disable=broad-except
        log.warning("audit emit drain failed: %s", err)
    finally:
        _drain_task = None


def _enqueue(body: Dict[str, Any], call_id: Optional[str]) -> None:
    global _dropped  # pylint: disable=global-statement
    if len(_queue) == _queue.maxlen:
        _dropped += 1
        if _dropped == 1 or _dropped % 100 == 0:
            log.warning(
                "audit emit queue full (max=%s); dropped %s event(s) so far. "
                "This emitter is at-most-once by design.",
                _queue.maxlen, _dropped,
            )
    _queue.append({"body": body, "attempts": 0, "call_id": call_id})


def _ensure_drain() -> None:
    global _drain_task  # pylint: disable=global-statement
    if _drain_task is not None and not _drain_task.done():
        return
    loop = asyncio.get_running_loop()  # caller handles RuntimeError
    _drain_task = loop.create_task(_drain())


def emit_llm_call(**fields: Any) -> None:
    """Fire-and-forget the cost event for one gateway call. NEVER RAISES.

    Off by default: with GATEWAY_AUDIT_EMIT_ENABLED unset this returns before
    building anything, so behaviour is byte-for-byte what it was before this
    emitter existed.
    """
    try:
        if not emit_enabled():
            return
        if not AUDIT_GOV_URL:
            return
        body = build_event(**fields)
        _enqueue(body, fields.get("gateway_call_id"))
        _ensure_drain()
    except RuntimeError:
        # No running event loop (sync context / test harness). Nothing to
        # schedule onto; the queued event drains on the next emit that has one.
        pass
    except Exception as err:  # pylint: disable=broad-except
        # The last-resort record of this call is the task_tags.emit_call_audit
        # log line the router already wrote. Never let telemetry fail the call.
        log.warning("audit emit skipped: %s", err)


def queue_depth() -> int:
    """Diagnostic — pending events not yet accepted by audit-gov."""
    return len(_queue)


def dropped_count() -> int:
    """Diagnostic — events discarded because the bounded queue was full."""
    return _dropped


def reset_for_tests() -> None:
    """Clear module state. Tests only."""
    global _drain_task, _dropped  # pylint: disable=global-statement
    _queue.clear()
    _drain_task = None
    _dropped = 0
