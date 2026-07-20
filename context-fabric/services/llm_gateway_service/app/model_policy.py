"""B1 — Declarative model-selection policy at the gateway.

Until this file existed the platform had no model selection at all. It had
twenty-odd `*_MODEL_ALIAS` environment variables — DISTILL_MODEL_ALIAS,
JUDGE_MODEL_ALIAS, CAPSULE_COMPILE_MODEL_ALIAS, SUMMARISE_MODEL_ALIAS and the
rest — each freezing one choice at deploy time, each invisible to the gateway
that actually spends the money. The gateway resolved whatever alias it was
handed and had no opinion about it. That is not a routing layer; it is a lookup
table with extra hops, and changing where the platform's money goes meant a
config sweep and a restart.

This module is the routing layer. The task identity the caller already sends
across the hop (`task_tag`, `stage`, `purpose` — see task_tags.py) is the
routing key; a declarative file maps it onto a TIER, and a tier onto an ordered
list of catalog aliases.

Three constraints shaped what is here, and — more importantly — what is not:

  - It is a POLICY, not an optimizer. There is no quality signal anywhere in
    this platform: no eval harness, no thumbs-up, no regression suite over model
    output. A learned router or a quality-based escalator would therefore be
    fitting noise and calling it intelligence, and the failure mode is invisible
    (it just quietly picks worse models). Everything here is a rule an operator
    wrote down and can read back.
  - Every decision is explainable in ONE line. `reason` is not decoration. A
    routing layer nobody can audit is a routing layer nobody will ever trust
    with the production default, so it would sit switched off forever.
  - It is OFF by default (`GATEWAY_MODEL_POLICY_ENABLED`). While off, resolution
    is byte-identical to what it was before this file existed — the router does
    not even call in here. Collapsing the env vars onto this engine and turning
    it on are separate, reversible steps.

Policy file (path from `LLM_POLICY_PATH`, default /etc/singularity/llm-policy.json):

    {
      "version": 1,
      "tiers": {
        "cheap":    ["claude-haiku-4-5-20251001"],
        "standard": ["claude-sonnet-4-6"],
        "deep":     ["claude-opus-4-1", "claude-sonnet-4-6"]
      },
      "defaultTier": "standard",
      "routes": [
        {"when": {"task_tag": "world_model_distill"}, "tier": "cheap"},
        {"when": {"task_tag": "agent_turn", "stage": "develop"}, "tier": "deep"}
      ],
      "escalateWhenInputTokensExceed": {"cheap": 60000, "standard": 150000}
    }

Tiers are LISTS rather than single values so resolution can walk down them when
a provider is not ready. Today an unready alias is a hard 503; with a list, the
second entry is the answer instead of an outage.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .config import settings
from .task_tags import normalize_task_tag


logger = logging.getLogger("llm_gateway.policy")

_TRUTHY = {"1", "true", "yes", "on"}

# The only keys a `when` clause may match on. Closed on purpose: an unrecognised
# key is a typo, and a typo that silently BROADENS a route (by being ignored) is
# how a cheap-tier rule quietly starts catching production agent turns. Routes
# carrying unknown keys are dropped at load time, loudly.
MATCHABLE_SIGNALS = ("task_tag", "stage", "purpose")

# Ordered cheapest → deepest. This is the ladder size-escalation walks, and it
# walks exactly one rung. Tiers named outside this vocabulary still route fine;
# they just cannot be an escalation source or target, because there is no
# defined "next" for them.
TIER_ORDER = ("cheap", "standard", "deep")

DEFAULT_POLICY_PATH = "/etc/singularity/llm-policy.json"

# Routing sources, echoed as `routing.source`. Each answers "who chose this".
SOURCE_CALLER_PIN = "caller_pin"          # model_alias — a hard pin, policy skipped
SOURCE_EXPECTED_MODEL = "expected_model"  # replay/immutable caller, policy skipped
SOURCE_CALLER_TIER = "caller_tier"        # model_tier hint; policy picked within it
SOURCE_POLICY = "policy"                  # a route matched
SOURCE_POLICY_DEFAULT = "policy_default"  # no route matched; defaultTier used


_loaded_policy: Optional[Dict[str, Any]] = None
_warnings: List[str] = []


@dataclass(frozen=True)
class RoutingDecision:
    """One routing decision, explainable in one audit line."""

    source: str
    tier: Optional[str]
    alias: Optional[str]
    reason: str
    escalated_from: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        block: Dict[str, Any] = {
            "source": self.source,
            "tier": self.tier,
            "alias": self.alias,
            "reason": self.reason,
        }
        # Only present when it actually happened, so its presence in a log or a
        # response body is itself the signal that an escalation fired.
        if self.escalated_from:
            block["escalated_from"] = self.escalated_from
        return block


def policy_enabled() -> bool:
    """Whether the policy engine participates in resolution at all.

    Read per-call, like task_tags.require_task_tag(), because this is a rollout
    kill switch: an operator watching a bad rollout must be able to flip it back
    without a gateway restart, and a restart is exactly what you cannot get
    quickly when routing is misbehaving.
    """
    return os.getenv("GATEWAY_MODEL_POLICY_ENABLED", "").strip().lower() in _TRUTHY


def _policy_path() -> Path:
    return Path(getattr(settings, "llm_policy_path", None) or DEFAULT_POLICY_PATH)


def _warn(message: str) -> None:
    if message not in _warnings:
        _warnings.append(message)
        logger.warning("llm_gateway.policy_config %s", message)


def _load_policy() -> Dict[str, Any]:
    """Load + cache the policy file, degrading to an inert policy on any problem.

    Same caching and degrade shape as provider_config._load_catalog(): a missing
    or malformed file produces a warning and an empty policy, never an
    exception. A routing layer that can take the gateway down when its config
    file is bad is strictly worse than no routing layer.
    """
    global _loaded_policy
    if _loaded_policy is not None:
        return _loaded_policy
    path = _policy_path()
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        _warn(f"Model policy not found at {path}; policy routing is inert.")
        _loaded_policy = _empty_policy()
        return _loaded_policy
    except Exception as exc:  # noqa: BLE001 — malformed JSON must not 500 the gateway
        _warn(f"Model policy parse error: {exc}; policy routing is inert.")
        _loaded_policy = _empty_policy()
        return _loaded_policy
    if not isinstance(raw, dict):
        _warn("Model policy must be a JSON object; policy routing is inert.")
        _loaded_policy = _empty_policy()
        return _loaded_policy
    _loaded_policy = _sanitize_policy(raw)
    return _loaded_policy


def _empty_policy() -> Dict[str, Any]:
    return {"version": 1, "tiers": {}, "defaultTier": None, "routes": [], "escalate": {}}


def _sanitize_policy(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate per-entry, warn per-entry, keep going.

    Mirrors _sanitize_catalog: one bad route must not discard the other nine.
    """
    version = raw.get("version")
    if version != 1:
        _warn(f"Model policy version {version!r} is not 1; parsing it as version 1.")

    tiers: Dict[str, List[str]] = {}
    raw_tiers = raw.get("tiers")
    if raw_tiers is None:
        _warn("Model policy has no tiers; policy routing is inert.")
    elif not isinstance(raw_tiers, dict):
        _warn("Model policy tiers must be an object; policy routing is inert.")
    else:
        for name, candidates in raw_tiers.items():
            tier = normalize_task_tag(name)
            if not tier:
                _warn(f"Model policy tier {name!r} ignored: blank name.")
                continue
            if isinstance(candidates, str):
                # A tier is a LIST so resolution can walk it. Accept the singular
                # shape rather than dropping the tier — but say so, because a
                # one-entry tier has no fallback and that is worth knowing.
                _warn(f"Model policy tier {tier!r} is a string; treating it as a one-entry list.")
                candidates = [candidates]
            if not isinstance(candidates, list):
                _warn(f"Model policy tier {tier!r} ignored: expected a list of model aliases.")
                continue
            clean = [str(c).strip() for c in candidates if str(c or "").strip()]
            if not clean:
                _warn(f"Model policy tier {tier!r} ignored: no model aliases.")
                continue
            if tier not in TIER_ORDER:
                _warn(
                    f"Model policy tier {tier!r} is outside the known ladder "
                    f"({', '.join(TIER_ORDER)}); it routes but cannot escalate."
                )
            tiers[tier] = clean

    default_tier = normalize_task_tag(raw.get("defaultTier"))
    if default_tier and default_tier not in tiers:
        _warn(f"Model policy defaultTier {default_tier!r} is not a defined tier; ignoring it.")
        default_tier = None

    routes: List[Dict[str, Any]] = []
    raw_routes = raw.get("routes")
    if raw_routes is not None and not isinstance(raw_routes, list):
        _warn("Model policy routes must be an array; ignoring them.")
        raw_routes = None
    for index, entry in enumerate(raw_routes or []):
        route = _sanitize_route(index, entry, tiers)
        if route is not None:
            routes.append(route)

    escalate: Dict[str, int] = {}
    raw_escalate = raw.get("escalateWhenInputTokensExceed")
    if raw_escalate is not None and not isinstance(raw_escalate, dict):
        _warn("Model policy escalateWhenInputTokensExceed must be an object; ignoring it.")
        raw_escalate = None
    for name, threshold in (raw_escalate or {}).items():
        tier = normalize_task_tag(name)
        if not tier or tier not in tiers:
            _warn(f"Model policy escalation threshold for {name!r} ignored: not a defined tier.")
            continue
        if isinstance(threshold, bool) or not isinstance(threshold, int) or threshold <= 0:
            _warn(f"Model policy escalation threshold for {tier!r} ignored: expected a positive integer.")
            continue
        escalate[tier] = threshold

    return {
        "version": 1,
        "tiers": tiers,
        "defaultTier": default_tier,
        "routes": routes,
        "escalate": escalate,
    }


def _sanitize_route(index: int, entry: Any, tiers: Dict[str, List[str]]) -> Optional[Dict[str, Any]]:
    if not isinstance(entry, dict):
        _warn(f"Model policy route {index} ignored: expected object.")
        return None
    tier = normalize_task_tag(entry.get("tier"))
    if not tier:
        _warn(f"Model policy route {index} ignored: missing tier.")
        return None
    if tier not in tiers:
        _warn(f"Model policy route {index} ignored: tier {tier!r} is not defined.")
        return None
    when = entry.get("when", {})
    if when is None:
        when = {}
    if not isinstance(when, dict):
        _warn(f"Model policy route {index} ignored: `when` must be an object.")
        return None
    clean_when: Dict[str, str] = {}
    for key, value in when.items():
        signal = str(key or "").strip()
        if signal not in MATCHABLE_SIGNALS:
            # Fail closed. Ignoring the unknown key would leave a BROADER route
            # than the operator wrote, which is the dangerous direction.
            _warn(
                f"Model policy route {index} ignored: unknown `when` key {signal!r} "
                f"(one of {', '.join(MATCHABLE_SIGNALS)})."
            )
            return None
        normalized = normalize_task_tag(value)
        if not normalized:
            _warn(f"Model policy route {index} ignored: blank value for `when.{signal}`.")
            return None
        clean_when[signal] = normalized
    return {"when": clean_when, "tier": tier}


# ── Signals ─────────────────────────────────────────────────────────────────
def estimate_input_tokens(messages: Any) -> int:
    """Rough input size from the messages the gateway already holds.

    THE one genuinely automatic signal in this engine. Everything else is an
    operator's rule about a caller's declared identity, which cannot tell
    "distill a README" apart from "distill a 200-file repo" — both arrive tagged
    world_model_distill, and only one of them belongs on a cheap model. Size
    separates them with no configuration at all.

    chars/4 is deliberately crude. An exact tokenizer would mean shipping a
    per-provider vocabulary into the routing path to make a decision whose
    thresholds an operator picked by eyeballing anyway; the error bar on the
    threshold dwarfs the error bar on the estimate.
    """
    if not messages:
        return 0
    total = 0
    for message in messages:
        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content")
        if isinstance(content, str):
            total += len(content)
    return total // 4


def _match_route(routes: List[Dict[str, Any]], signals: Dict[str, Optional[str]]) -> Optional[Dict[str, Any]]:
    """Most-specific `when` wins; ties broken by file order.

    Specificity is the count of matched keys, so {task_tag, stage} beats
    {task_tag}. The strict `>` below is what makes the FIRST route at a given
    specificity win — file order is the documented tiebreak, and an operator
    reading top-to-bottom should not have to know a later duplicate silently
    shadows an earlier one.
    """
    best: Optional[Dict[str, Any]] = None
    best_specificity = -1
    for route in routes:
        when = route["when"]
        if any(signals.get(key) != value for key, value in when.items()):
            continue
        specificity = len(when)
        if specificity > best_specificity:
            best = route
            best_specificity = specificity
    return best


def _escalate_one_step(tier: str, estimated_input_tokens: int, escalate: Dict[str, int]) -> Tuple[str, Optional[str]]:
    """Move up at most ONE rung when the input is too big for the chosen tier.

    One rung, not "as far as it takes": escalation is a guard rail, not a
    second routing system. If a cheap tier is genuinely wrong for a whole class
    of traffic, that is a route the operator should write down, not something
    the engine should keep inferring at request time.
    """
    threshold = escalate.get(tier)
    if threshold is None or estimated_input_tokens <= threshold:
        return tier, None
    if tier not in TIER_ORDER:
        return tier, None
    index = TIER_ORDER.index(tier)
    if index + 1 >= len(TIER_ORDER):
        return tier, None  # already the deepest rung; nowhere to go
    return TIER_ORDER[index + 1], tier


def _first_ready(candidates: List[str], is_ready: Callable[[str], bool]) -> Tuple[Optional[str], List[str]]:
    """Walk the tier list and take the first alias whose provider is ready.

    This is why tiers are lists. Today an unready alias is a 503 the caller
    cannot do anything about; here it is simply the reason the next entry gets
    the traffic.
    """
    skipped: List[str] = []
    for alias in candidates:
        try:
            ready = bool(is_ready(alias))
        except Exception:  # noqa: BLE001 — a readiness probe must not fail the call
            ready = False
        if ready:
            return alias, skipped
        skipped.append(alias)
    return None, skipped


# ── Entry point ─────────────────────────────────────────────────────────────
def resolve(
    *,
    model_alias: Optional[str] = None,
    expected_model: Optional[str] = None,
    model_tier: Optional[str] = None,
    task_tag: Optional[str] = None,
    stage: Optional[str] = None,
    purpose: Optional[str] = None,
    estimated_input_tokens: int = 0,
    is_ready: Callable[[str], bool],
) -> Optional[RoutingDecision]:
    """Decide which alias should serve this call, or None to leave it alone.

    None means "policy has no opinion" and the caller must fall back to the
    pre-policy resolution path unchanged. That is the degrade for every failure
    here — disabled, no policy file, no matching tier, nothing ready — because
    the alternative is a routing layer that can invent an outage out of its own
    misconfiguration.

    Precedence, highest first:
      1. model_alias      → HARD PIN. Policy is skipped entirely.
      2. expected_model   → replay/immutable caller. Policy is skipped entirely,
                            because re-routing a caller that is asserting which
                            model it froze against is precisely the bug its
                            drift guard exists to catch.
      3. model_tier       → soft hint. Policy picks WITHIN that tier.
      4. matching route   → most-specific `when` wins.
      5. defaultTier      → the catch-all.
    """
    if not policy_enabled():
        return None

    if model_alias:
        return RoutingDecision(
            source=SOURCE_CALLER_PIN,
            tier=None,
            alias=model_alias,
            reason=f"caller pinned model_alias={model_alias}; policy skipped",
        )

    if expected_model:
        # Note the ordering against model_tier below: a caller that sends BOTH a
        # tier hint and an expected_model is still not re-routed. The hint is a
        # preference; the drift guard is an assertion.
        return RoutingDecision(
            source=SOURCE_EXPECTED_MODEL,
            tier=None,
            alias=None,
            reason=f"caller pinned expected_model={expected_model}; policy skipped",
        )

    policy = _load_policy()
    tiers: Dict[str, List[str]] = policy["tiers"]
    if not tiers:
        return None

    signals = {
        "task_tag": normalize_task_tag(task_tag),
        "stage": normalize_task_tag(stage),
        "purpose": normalize_task_tag(purpose),
    }

    hinted = normalize_task_tag(model_tier)
    if hinted and hinted in tiers:
        source = SOURCE_CALLER_TIER
        tier = hinted
        reason_head = f"caller hinted model_tier={tier}"
    else:
        if hinted:
            _warn(f"Caller sent model_tier={hinted!r}, which is not a defined tier; falling back to policy.")
        route = _match_route(policy["routes"], signals)
        if route is not None:
            source = SOURCE_POLICY
            tier = route["tier"]
            reason_head = f"matched {_describe_when(route['when'])} -> {tier}"
        else:
            tier = policy["defaultTier"]
            if not tier:
                return None
            source = SOURCE_POLICY_DEFAULT
            reason_head = f"no route matched {_describe_signals(signals)}; defaultTier={tier}"

    tier, escalated_from = _escalate_one_step(tier, estimated_input_tokens, policy["escalate"])
    if escalated_from:
        threshold = policy["escalate"][escalated_from]
        reason_head += (
            f"; escalated {escalated_from} -> {tier} "
            f"(~{estimated_input_tokens} input tokens > {threshold})"
        )

    alias, skipped = _first_ready(tiers.get(tier, []), is_ready)
    if alias is None:
        _warn(
            f"Model policy resolved tier {tier!r} but no candidate is ready "
            f"({', '.join(skipped) or 'tier is empty'}); falling back to default resolution."
        )
        return None
    if skipped:
        reason_head += f"; skipped unready {', '.join(skipped)}"

    return RoutingDecision(
        source=source,
        tier=tier,
        alias=alias,
        reason=f"{reason_head}; chose {alias}",
        escalated_from=escalated_from,
    )


def _describe_when(when: Dict[str, str]) -> str:
    if not when:
        return "catch-all route"
    return "route " + ",".join(f"{key}={value}" for key, value in sorted(when.items()))


def _describe_signals(signals: Dict[str, Optional[str]]) -> str:
    described = ",".join(f"{key}={value}" for key, value in sorted(signals.items()) if value)
    return described or "no signals"


def describe() -> Dict[str, Any]:
    """Introspection for /llm/providers and the preview endpoint."""
    policy = _load_policy()
    return {
        "enabled": policy_enabled(),
        "path": str(_policy_path()),
        "tiers": {name: list(candidates) for name, candidates in policy["tiers"].items()},
        "default_tier": policy["defaultTier"],
        "route_count": len(policy["routes"]),
        "escalate_when_input_tokens_exceed": dict(policy["escalate"]),
        "warnings": list(_warnings),
    }


def warnings() -> List[str]:
    return list(_warnings)


def reset_cache_for_tests() -> None:
    """Test-only: drop the cached policy so the next load reads from disk."""
    global _loaded_policy, _warnings
    _loaded_policy = None
    _warnings = []
