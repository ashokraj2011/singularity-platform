r"""
PII masking on the OUTBOUND prompt, before provider egress.

CF already masks PII in one direction: tool output is tokenised on the way
*toward* the model (`loop.py:868`) and untokenised on the way *away* from it
(`loop.py:708`, `loop.py:786`). The prompt itself was never masked, so the goal
text an operator typed — the single most likely place for a real SSN or a
customer's email — reached the provider verbatim.

This module closes that, narrowly.

────────────────────────────────────────────────────────────────────────────
WHY ONLY THREE KINDS, AND WHY THE OTHER THREE ARE A BUG WAITING TO HAPPEN
────────────────────────────────────────────────────────────────────────────
`pii_mask.detect_pii` knows six regex kinds: ssn, email, phone, credit_card,
zip9, ip. This module runs THREE of them: **ssn, email, credit_card** (the last
Luhn-validated). The exclusions are deliberate and should not be "completed"
later because they look like an easy win:

  • **ipv4** — source code is full of dotted quads that are not addresses at
    all: version strings (`1.2.3.4`), byte offsets, semver-with-build, netmask
    literals, test fixtures. And the ones that ARE addresses are usually the
    exact thing the agent was asked about. Mask `192.168.1.1` out of a config an
    agent is debugging and it answers confidently about a host that was never
    there.

  • **zip9** — `\d{5}-\d{4}` matches ZIP+9 and also matches ranges, ids, dates,
    port ranges, and a great deal of ordinary numeric test data.

  • **phone** — the NANP pattern matches large numeric literals with separators.
    Same failure mode.

The failure mode those three share is what makes them different in kind from a
leaked secret, not merely riskier: **a mask on the egress path corrupts the
model's input silently**. A leaked credential is a loud, findable event with an
incident response. A prompt where `192.168.1.1` became `[IP_1]` produces a
confident wrong answer that looks exactly like a right one. Nobody gets paged
for it. Given a choice between over-redacting and being quietly wrong, the
egress path must prefer the leak it can see over the corruption it cannot.

The three kinds kept are the ones where a match is strong evidence of the thing
itself rather than evidence of a shape: an SSN pattern, an RFC-ish email, and a
13-19 digit run that passes a Luhn checksum.

This mirrors the reasoning in `llm_gateway_service/app/secret_redaction.py`,
which for the same reason refused to port turn.py's generic
`(api_key|secret|password|token)\s*[:=]\s*\S+` rule onto the egress path.

Residual false positives, stated rather than hidden:
  • an email in a copyright header, an AUTHORS file, or a `Co-Authored-By:`
    trailer is a real email and WILL be tokenised. It is reversible and stable,
    but the model sees `[EMAIL_1]` where a maintainer's address was.
  • a 16-digit numeric literal passing Luhn by chance (~1 in 10 of those that
    match the shape at all).
Shadow mode exists to measure exactly this before anyone enforces it.

────────────────────────────────────────────────────────────────────────────
THE ROUND TRIP — the part that makes this more than a filter
────────────────────────────────────────────────────────────────────────────
Masking the prompt is not a one-way scrub. The token map is stage-scoped state
(`PhaseState.pii_token_map`, persisted across turns AND across pause/resume), and
the governed loop already reverses tokens on the way out:

    prompt (masked here)  ──▶ model ──▶ tool call args ──▶ unmask_pii_in_args()
                                                            (loop.py:708, 786)

So tokens minted HERE must land in the SAME `PhaseState.pii_token_map` the loop
unmasks against, before `governed_step` runs. If they do not, a model that
faithfully echoes `[EMAIL_1]` into a tool argument sends the literal string
`[EMAIL_1]` downstream, and the tool fails or acts on garbage.

`apply_to_messages` therefore returns the updated map and the caller
(`turn.py`) folds it into `state` before dispatch. That is why this returns a
map at all instead of just masked text.

**Shadow mode must NOT mint tokens.** It returns the original messages AND the
original map. Allocating tokens the model never saw would poison the unmask
path: `unmask_pii_in_args` would then rewrite a literal `[EMAIL_1]` that a user
legitimately typed into a value they never asked for. Shadow means *change
nothing*, including state.

WHAT THIS DOES NOT COVER. The model's free-text output is not untokenised. If the
model writes `[EMAIL_1]` into a phase output or a final answer, it stays a token
there. That is pre-existing — masked tool results (loop.py:868) already put
tokens in front of the model — and it is visible rather than silent, which is
the right side of the trade. Widening the unmask to assistant prose is a
separate change with its own risk (it would rewrite tokens a user typed).

────────────────────────────────────────────────────────────────────────────
ROLLOUT — opt-in, then measure, then enforce
────────────────────────────────────────────────────────────────────────────
Same shape as the gateway secret redaction (PR #573), but stricter: that one
defaults to shadow-for-everyone, this one defaults to OFF-for-everyone, because
it can change what the model reads rather than only what it is sent.

    CF_MASK_PROMPT_PII               off (default) | shadow | enforce
    CF_MASK_PROMPT_PII_CAPABILITIES  comma-separated capability ids, or *
    CF_MASK_PROMPT_PII_TENANTS       comma-separated tenant ids, or *

BOTH a mode and a matching scope are required. An empty allowlist matches
nothing — "opt-in" means somebody named a capability or a tenant, not that a
mode was left on. Mode is read per call, so an operator can pull it back to off
without a restart.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Iterable, Mapping

from .pii_mask import PiiKind, mask_pii

logger = logging.getLogger("context_fabric.outbound_pii")


# The high-precision subset. See the module docstring before adding to this.
# phone / zip9 / ip are excluded ON PURPOSE.
OUTBOUND_PII_KINDS: tuple[PiiKind, ...] = ("ssn", "email", "credit_card")

MODE_OFF = "off"
MODE_SHADOW = "shadow"
MODE_ENFORCE = "enforce"
_MODES = (MODE_OFF, MODE_SHADOW, MODE_ENFORCE)

_ENV_MODE = "CF_MASK_PROMPT_PII"
_ENV_CAPABILITIES = "CF_MASK_PROMPT_PII_CAPABILITIES"
_ENV_TENANTS = "CF_MASK_PROMPT_PII_TENANTS"

_WILDCARD = "*"


def _configured_mode() -> str:
    """The configured mode, independent of scope.

    Read per call rather than at import so shadow -> enforce (or straight back
    to off) needs no restart. An unrecognised value falls back to OFF, not to
    shadow: on this path an ambiguous configuration must mean "do nothing",
    since the alternative is silently altering prompts.
    """
    raw = os.getenv(_ENV_MODE, "").strip().lower()
    if raw in _MODES:
        return raw
    if raw:
        logger.warning(
            "context_fabric.outbound_pii_unknown_mode value=%s -- falling back to %s (expected one of: %s)",
            raw, MODE_OFF, ", ".join(_MODES),
        )
    return MODE_OFF


def _allowlist(env_name: str) -> set[str]:
    raw = os.getenv(env_name, "") or ""
    return {part.strip() for part in raw.split(",") if part.strip()}


def _scope_opted_in(capability_id: str | None, tenant_id: str | None) -> bool:
    """Whether this call's capability or tenant opted in.

    Either match is enough: an operator may roll out per capability (one
    workflow at a time) or per tenant (one customer at a time) without having to
    enumerate the cross product.

    Empty allowlists match nothing. That is what makes this opt-IN — leaving
    CF_MASK_PROMPT_PII=shadow set with no scope named must not quietly enable it
    fleet-wide.
    """
    capabilities = _allowlist(_ENV_CAPABILITIES)
    tenants = _allowlist(_ENV_TENANTS)

    if _WILDCARD in capabilities or _WILDCARD in tenants:
        return True
    if capability_id and capability_id in capabilities:
        return True
    if tenant_id and tenant_id in tenants:
        return True
    return False


def effective_mode(capability_id: str | None, tenant_id: str | None) -> str:
    """The mode that actually applies to this call: OFF unless a mode is set
    AND this capability/tenant is named."""
    mode = _configured_mode()
    if mode == MODE_OFF:
        return MODE_OFF
    if not _scope_opted_in(capability_id, tenant_id):
        return MODE_OFF
    return mode


def scope_from_run_context(
    run_context: Mapping[str, Any] | None,
) -> tuple[str | None, str | None]:
    """(capability_id, tenant_id) from a run context, tolerating both the
    snake_case and camelCase spellings that coexist on the wire.

    Deliberately NOT `placement.runtime_tenant_target()`: that helper answers a
    different question (which runtime should serve this call) and returns None
    in enterprise mode. Using it here would silently drop tenant opt-in for
    exactly the deployments most likely to want it.
    """
    rc = run_context or {}
    capability_id = rc.get("capability_id") or rc.get("capabilityId")
    tenant_id = (
        rc.get("tenant_id") or rc.get("tenantId")
        or rc.get("org_id") or rc.get("orgId")
    )
    return (
        str(capability_id) if capability_id else None,
        str(tenant_id) if tenant_id else None,
    )


def _merge_findings(
    into: dict[str, dict[str, Any]], applied: Iterable[Mapping[str, Any]],
) -> None:
    for entry in applied:
        kind = entry.get("kind")
        if not kind:
            continue
        count = int(entry.get("count") or 0)
        if kind in into:
            into[kind]["count"] += count
        else:
            into[kind] = {"kind": kind, "count": count}


def mask_messages(
    messages: list[dict[str, Any]],
    token_map: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, str], list[dict[str, Any]]]:
    """Mask the narrow PII kinds in each message's string ``content``.

    Returns ``(masked_messages, updated_token_map, findings)``. Findings carry
    kind + count ONLY — never the matched value, because these are destined for
    a log and a PII log that quotes the PII is worse than no log.

    Pure: never mutates the inputs. Non-string content (Anthropic-style block
    lists, tool payloads) is passed through untouched rather than guessed at;
    the governed path composes string content, and quietly restructuring an
    unfamiliar shape is how prompts get corrupted.
    """
    new_map: dict[str, str] = dict(token_map or {})
    tally: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []

    for message in messages or []:
        if not isinstance(message, dict):
            out.append(message)
            continue
        content = message.get("content")
        if not isinstance(content, str) or not content:
            out.append(message)
            continue

        result = mask_pii(content, new_map, OUTBOUND_PII_KINDS)
        if not result.applied:
            out.append(message)
            continue

        new_map = result.token_map
        _merge_findings(tally, result.applied)
        clone = dict(message)
        clone["content"] = result.masked
        out.append(clone)

    # Kind order, not match order, so the same prompt always reports identically.
    findings = [
        {"kind": kind, "count": tally[kind]["count"]}
        for kind in OUTBOUND_PII_KINDS
        if kind in tally
    ]
    return out, new_map, findings


def _log_findings(
    *,
    mode: str,
    capability_id: str | None,
    tenant_id: str | None,
    findings: list[dict[str, Any]],
) -> None:
    logger.warning(
        "context_fabric.outbound_pii mode=%s capability=%s tenant=%s total=%s findings=%s",
        mode,
        capability_id or "-",
        tenant_id or "-",
        sum(int(f["count"]) for f in findings),
        ",".join(f"{f['kind']}:{f['count']}" for f in findings),
    )


def apply_to_messages(
    messages: list[dict[str, Any]],
    *,
    token_map: dict[str, str] | None = None,
    capability_id: str | None = None,
    tenant_id: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, str], str, list[dict[str, Any]]]:
    """What to actually send upstream, plus the token map that must go with it.

    Returns ``(messages, token_map, mode, findings)``.

      off     — inputs returned unchanged, no work done.
      shadow  — findings computed and logged; ORIGINAL messages AND ORIGINAL
                token map returned. Minting tokens in shadow would corrupt the
                unmask path (see the module docstring), so shadow changes
                nothing at all.
      enforce — masked messages AND the grown token map. The CALLER MUST fold
                that map into PhaseState before governed_step(), or a token the
                model echoes into a tool argument will not be reversed.

    NEVER raises. Every failure path returns the original messages and the
    original map: a bug in masking must degrade to today's behaviour, not take
    down the governed loop.
    """
    original_map = dict(token_map or {})
    try:
        mode = effective_mode(capability_id, tenant_id)
        if mode == MODE_OFF:
            return messages, original_map, MODE_OFF, []
        masked, new_map, findings = mask_messages(messages, original_map)
    except Exception as exc:  # pylint: disable=broad-except
        # The exception TYPE only. An exception's message can quote the very
        # text this module exists to keep out of logs.
        logger.error(
            "context_fabric.outbound_pii_failed error_type=%s -- sending the original prompt",
            type(exc).__name__,
        )
        return messages, original_map, MODE_OFF, []

    # Logging is guarded SEPARATELY from the decision about what to send. Folded
    # together, a failure while writing the audit line would take the
    # return-original path and silently defeat enforcement — an observability
    # bug must never change what egresses.
    if findings:
        try:
            _log_findings(
                mode=mode,
                capability_id=capability_id,
                tenant_id=tenant_id,
                findings=findings,
            )
        except Exception:  # pylint: disable=broad-except
            pass

    if mode == MODE_ENFORCE:
        return masked, new_map, mode, findings
    return messages, original_map, MODE_SHADOW, findings
