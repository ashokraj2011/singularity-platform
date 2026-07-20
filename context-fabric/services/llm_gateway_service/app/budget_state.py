"""B3 — the spend signal that budget degradation reads.

The gateway decides which model serves a call. Until now it decided that with no
idea how much money the caller had already spent, so "we are 95% through the
month's budget" could not influence anything. audit-gov has maintained a
`budgets` table for a long time (cost-worker.ts bumps current_tokens /
current_cost on every priced call) and exposes GET /budgets/check. This module is
the read side of that, and nothing more: it answers "how much of this scope's
budget is used", and model_policy decides what to do about it.

Three properties matter more than accuracy here:

  - FAIL OPEN, ALWAYS. Every failure — audit-gov down, timeout, malformed body,
    no budget configured — reports "no pressure". A budget service outage must
    not silently move the whole platform onto cheaper models; that is a quality
    incident caused by a monitoring dependency, which is a strictly worse
    failure than not degrading at all.
  - CACHED. Budget state moves on the scale of minutes and this sits in the
    request path of every LLM call. An uncached lookup would add a network hop
    per call to save money, which is its own kind of funny.
  - HONEST ABOUT WHAT IT MEASURES. See the coverage note below. The number this
    returns is a LOWER BOUND on spend, not spend.

    COVERAGE (read this before trusting a percentage):
    `budgets` is bumped from `llm.call.completed` audit events, and the only
    producer of those today is mcp-server's invoke path. Calls that reach the
    gateway directly — the D1 direct-to-gateway path, claim-registry lowering,
    audit-gov judging, world-model distillation — never produce one, so their
    spend is invisible here. A tenant can therefore be far past its real budget
    while this reports 20%. That is why degradation ships OFF by default and why
    the reason string records the observed percentage rather than asserting a
    verdict: an operator reading a degradation event needs to be able to tell
    "we degraded because spend is genuinely high" from "we degraded because the
    only spend we can see happens to be the MCP-relayed subset".

SPOOFABILITY. The scope id comes from the request's tenant_id / capability_id,
which are attribution, not authorization — the gateway sits behind one shared
bearer, so any caller can claim any tenant. That is precisely why routing keys
stay task_tag/stage/purpose and these never become `when` keys. Budget is not a
route match; it is a cost-control adjustment applied AFTER routing, and the
worst a spoofed scope buys is a caller escaping a cheaper model — i.e. spending
more of its own real budget, which the budget itself still records.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

import httpx


logger = logging.getLogger("llm_gateway.budget")

_TRUTHY = {"1", "true", "yes", "on"}

DEFAULT_TTL_SEC = 60.0
DEFAULT_TIMEOUT_SEC = 2.0

# {(scope_type, scope_id): (expires_at_monotonic, BudgetState)}
_CACHE: Dict[Tuple[str, str], Tuple[float, "BudgetState"]] = {}


@dataclass(frozen=True)
class BudgetState:
    """How much of a scope's budget is consumed, as a fraction in [0, 1].

    `used_fraction` is None when there is nothing to say — no budget configured,
    service unreachable, or the budget has no maximum set. None is not zero:
    zero means "measured, and nothing spent", None means "do not act on this".
    """

    used_fraction: Optional[float] = None
    scope_type: Optional[str] = None
    scope_id: Optional[str] = None
    reason: str = "no budget signal"

    @property
    def known(self) -> bool:
        return self.used_fraction is not None


UNKNOWN = BudgetState()


def degradation_enabled() -> bool:
    """Whether budget pressure may influence model selection at all.

    Read per-call like the other gateway kill switches: an operator watching
    quality dip needs to stop degradation without a restart, and a restart is
    the thing you cannot get quickly when routing is misbehaving.
    """
    return os.getenv("GATEWAY_BUDGET_DEGRADATION_ENABLED", "").strip().lower() in _TRUTHY


def _audit_gov_url() -> str:
    return (os.getenv("AUDIT_GOV_URL", "") or "").strip().rstrip("/")


def _ttl_sec() -> float:
    raw = os.getenv("GATEWAY_BUDGET_CACHE_TTL_SEC", "").strip()
    try:
        value = float(raw) if raw else DEFAULT_TTL_SEC
    except ValueError:
        return DEFAULT_TTL_SEC
    return value if value > 0 else DEFAULT_TTL_SEC


def _timeout_sec() -> float:
    raw = os.getenv("GATEWAY_BUDGET_TIMEOUT_SEC", "").strip()
    try:
        value = float(raw) if raw else DEFAULT_TIMEOUT_SEC
    except ValueError:
        return DEFAULT_TIMEOUT_SEC
    return value if value > 0 else DEFAULT_TIMEOUT_SEC


def _used_fraction_from_rows(rows: Any) -> Optional[float]:
    """Worst (highest) utilisation across every budget row for the scope.

    A scope can carry day/week/month budgets at once. The binding constraint is
    whichever is closest to its cap, so the maximum is the honest summary — an
    average would let a fresh monthly budget mask an exhausted daily one.
    """
    if not isinstance(rows, list):
        return None
    worst: Optional[float] = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        for used_key, max_key in (("current_tokens", "tokens_max"), ("current_cost", "cost_max_usd")):
            try:
                cap_raw = row.get(max_key)
                if cap_raw is None:
                    continue
                cap = float(cap_raw)
                if cap <= 0:
                    continue
                used = float(row.get(used_key) or 0)
            except (TypeError, ValueError):
                continue
            fraction = used / cap
            if worst is None or fraction > worst:
                worst = fraction
    return worst


async def fetch(scope_type: str, scope_id: str) -> BudgetState:
    """Current utilisation for one scope. Never raises, never blocks for long."""
    if not scope_type or not scope_id:
        return UNKNOWN
    base = _audit_gov_url()
    if not base:
        return BudgetState(reason="AUDIT_GOV_URL is not set; budget signal unavailable")

    key = (scope_type, scope_id)
    now = time.monotonic()
    cached = _CACHE.get(key)
    if cached and now < cached[0]:
        return cached[1]

    state = UNKNOWN
    try:
        async with httpx.AsyncClient(timeout=_timeout_sec()) as client:
            res = await client.get(
                f"{base}/api/v1/governance/budgets/check",
                params={"scope_type": scope_type, "scope_id": scope_id},
            )
        if res.status_code == 200:
            body = res.json()
            if isinstance(body, dict):
                fraction = _used_fraction_from_rows(body.get("budgets"))
                if fraction is None:
                    state = BudgetState(
                        scope_type=scope_type, scope_id=scope_id,
                        reason="no budget with a maximum configured for this scope",
                    )
                else:
                    state = BudgetState(
                        used_fraction=fraction, scope_type=scope_type, scope_id=scope_id,
                        reason=f"{scope_type}={scope_id} at {fraction:.0%} of budget",
                    )
        else:
            state = BudgetState(reason=f"budget check returned {res.status_code}")
    except Exception as exc:  # noqa: BLE001 — a budget probe must never fail a call
        # Logged, not raised, and cached like any other answer so a flapping
        # audit-gov cannot turn into a request-rate retry storm.
        logger.warning("llm_gateway.budget_check_failed scope=%s/%s error=%s", scope_type, scope_id, exc)
        state = BudgetState(reason=f"budget check failed: {exc}")

    _CACHE[key] = (now + _ttl_sec(), state)
    return state


def reset_cache_for_tests() -> None:
    _CACHE.clear()
