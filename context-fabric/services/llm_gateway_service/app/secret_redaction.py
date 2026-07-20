r"""
Secret redaction before provider egress.

Nothing on this platform redacted anything on the way OUT. The one mask that
exists — `context_api_service/app/governed/turn.py:_SECRET_MASKS` — is applied
only to the audit *capture copy*; the docstring at turn.py:116 says so plainly,
and the originals "still go to the gateway verbatim". Secrets were masked in the
log and sent in the clear, which is exactly backwards.

The gateway is where the real thing belongs. It is the single choke point every
LLM egress crosses — context-fabric, workgraph, mcp-server and the background
callers alike — so one implementation here covers all of them, where one per
caller would have covered none of them for long.

WHAT IS DELIBERATELY NOT HERE
    turn.py's final mask is a generic
        ("?(api_key|secret|password|token)"?\s*[:=]\s*"?)[^\s"',]{8,}
    rule. It is not ported and must not be added back. On an audit copy a false
    positive is free — the log is merely over-redacted. On the egress path the
    same match silently corrupts the prompt: an agent asked to read a config
    file, a docker-compose, or its own source gets «redacted» where the real
    value was, and then answers confidently from mangled input. A wrong answer
    nobody can see is a worse outcome than the leak it was trying to prevent.

    Every rule below is instead anchored on a structural prefix that essentially
    only occurs inside a real credential, so a match is evidence of a secret
    rather than evidence of the word "token".

Rollout is measure-then-enforce, via GATEWAY_REDACT_SECRETS:
    shadow (default) — find, count and log; send the ORIGINAL body. This
                       protects nothing. It tells you what enforcing would do.
    enforce          — send the redacted body.
    off              — skip entirely.
"""
from __future__ import annotations

import copy
import logging
import os
import re
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Tuple

logger = logging.getLogger("llm_gateway.redaction")


class _Rule(NamedTuple):
    name: str            # what gets logged — never the matched text
    pattern: re.Pattern
    replacement: str


# Ported from turn.py's `_SECRET_MASKS`, minus the generic key/value rule (see
# the module docstring), plus a few equally-anchored shapes. Replacement markers
# match turn.py's so an operator seeing «redacted» in a prompt recognises it.
_SECRET_RULES: Tuple[_Rule, ...] = (
    _Rule(
        "bearer_token",
        re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{12,}"),
        r"\1 «redacted»",
    ),
    _Rule(
        "authorization_value",
        re.compile(r"(?i)(authorization\"?\s*[:=]\s*\"?)(?:bearer\s+)?[A-Za-z0-9._\-]{12,}"),
        r"\1«redacted»",
    ),
    _Rule(
        "openai_api_key",
        re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"),
        "«redacted-key»",
    ),
    # The rule above cannot match either dominant modern shape: `sk-proj-…` and
    # `sk-ant-…` both hit a hyphen four characters in, where [A-Za-z0-9]{16,}
    # stops. Porting turn.py alone would therefore have missed the two key
    # formats this platform is most likely to have in a prompt.
    _Rule(
        "scoped_api_key",
        re.compile(r"\bsk-(?:proj|ant)-[A-Za-z0-9_\-]{16,}"),
        "«redacted-key»",
    ),
    _Rule(
        "github_token",
        re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
        "«redacted-token»",
    ),
    _Rule(
        "aws_access_key_id",
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        "«redacted-aws-key»",
    ),
    _Rule(
        "slack_token",
        re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
        "«redacted-token»",
    ),
    _Rule(
        "google_api_key",
        re.compile(r"\bAIza[A-Za-z0-9_\-]{35}\b"),
        "«redacted-key»",
    ),
    # A PEM private key in a prompt is never the config value an agent needed to
    # read, so collapsing the whole block costs nothing and the alternative is
    # shipping the key itself upstream.
    _Rule(
        "private_key_block",
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL),
        "«redacted-private-key»",
    ),
)

MODE_SHADOW = "shadow"
MODE_ENFORCE = "enforce"
MODE_OFF = "off"
_MODES = (MODE_SHADOW, MODE_ENFORCE, MODE_OFF)


def redaction_mode() -> str:
    """The active mode. Read per call rather than at import, so an operator can
    move shadow → enforce (or pull it straight back) without restarting the
    gateway — the same contract `task_tags.require_task_tag()` uses.

    An unrecognised value falls back to shadow instead of being guessed at, so
    every ambiguous configuration means "change nothing about the traffic".
    """
    raw = os.getenv("GATEWAY_REDACT_SECRETS", "").strip().lower()
    if raw in _MODES:
        return raw
    if raw:
        logger.warning(
            "llm_gateway.redaction_unknown_mode value=%s -- falling back to %s (expected one of: %s)",
            raw, MODE_SHADOW, ", ".join(_MODES),
        )
    return MODE_SHADOW


def _redact_text(text: str) -> Tuple[str, Dict[str, int]]:
    counts: Dict[str, int] = {}
    for rule in _SECRET_RULES:
        text, hits = rule.pattern.subn(rule.replacement, text)
        if hits:
            counts[rule.name] = counts.get(rule.name, 0) + hits
    return text, counts


def _content_of(message: Any) -> Any:
    if isinstance(message, dict):
        return message.get("content")
    return getattr(message, "content", None)


def _with_content(message: Any, content: str) -> Optional[Any]:
    """A copy of `message` carrying `content`, or None if this shape cannot be
    copied. Never mutates the original — the caller in shadow mode is still
    going to send it."""
    if isinstance(message, dict):
        clone = dict(message)
        clone["content"] = content
        return clone
    model_copy = getattr(message, "model_copy", None)  # pydantic v2 (ChatMessage)
    if callable(model_copy):
        try:
            return model_copy(update={"content": content})
        except Exception:  # pylint: disable=broad-except
            return None
    try:
        clone = copy.copy(message)
        clone.content = content
        return clone
    except Exception:  # pylint: disable=broad-except
        return None


def redact_messages(messages: Iterable[Any]) -> Tuple[List[Any], List[Dict[str, Any]]]:
    """Redact secret-shaped substrings in each message's `content`.

    Returns `(redacted_messages, findings)` where findings is a list of
    `{"pattern_name": str, "count": int}` — pattern name and count ONLY. The
    matched text is never carried out of this function, because the findings
    are destined for a log and a redaction log that leaks the secret is worse
    than no redaction at all.

    Pure: no I/O, no mutation of the input. Accepts dicts or pydantic messages.
    """
    counts: Dict[str, int] = {}
    out: List[Any] = []

    for message in messages or []:
        content = _content_of(message)
        if not isinstance(content, str) or not content:
            out.append(message)
            continue

        redacted, hits = _redact_text(content)
        if not hits:
            out.append(message)
            continue

        replaced = _with_content(message, redacted)
        if replaced is None:
            # Unknown message shape we could not copy. Keep the original and
            # drop its hits: a finding that claims a redaction which did not
            # happen would make the shadow numbers a lie.
            out.append(message)
            continue

        out.append(replaced)
        for name, hit_count in hits.items():
            counts[name] = counts.get(name, 0) + hit_count

    # Rule order, not match order, so the same body always reports identically.
    findings = [
        {"pattern_name": rule.name, "count": counts[rule.name]}
        for rule in _SECRET_RULES
        if rule.name in counts
    ]
    return out, findings


def _log_findings(
    *,
    mode: str,
    endpoint: str,
    model_alias: Optional[str],
    trace_id: Optional[str],
    findings: List[Dict[str, Any]],
) -> None:
    try:
        logger.warning(
            "llm_gateway.secret_redaction mode=%s endpoint=%s model_alias=%s trace_id=%s total=%s findings=%s",
            mode,
            endpoint,
            model_alias or "-",
            trace_id or "-",
            sum(int(f["count"]) for f in findings),
            ",".join(f"{f['pattern_name']}:{f['count']}" for f in findings),
        )
    except Exception:  # pylint: disable=broad-except
        pass


def redact_for_egress(
    messages: List[Any],
    *,
    endpoint: str,
    model_alias: Optional[str] = None,
    trace_id: Optional[str] = None,
) -> List[Any]:
    """The list of messages to actually send upstream.

    NEVER raises. Every failure path returns the original body: a bug in
    redaction must degrade to today's behaviour, not take down LLM traffic for
    the whole platform.
    """
    try:
        mode = redaction_mode()
        if mode == MODE_OFF:
            return messages
        redacted, findings = redact_messages(messages)
    except Exception as exc:  # pylint: disable=broad-except
        # The exception TYPE only. An exception's message can quote the very
        # input this module exists to keep out of the logs.
        logger.error(
            "llm_gateway.redaction_failed endpoint=%s error_type=%s -- sending the original body",
            endpoint,
            type(exc).__name__,
        )
        return messages

    # Logging sits OUTSIDE the block that decides what to send, and is guarded
    # separately. Folded in, a failure while writing the audit line would take
    # the fall-through path and ship the original body — an observability bug
    # would silently defeat enforcement, which is the one thing this must never
    # do. What goes upstream depends only on the redaction result.
    if findings:
        try:
            _log_findings(
                mode=mode,
                endpoint=endpoint,
                model_alias=model_alias,
                trace_id=trace_id,
                findings=findings,
            )
        except Exception:  # pylint: disable=broad-except
            pass

    # shadow: findings are logged, the caller's body goes out untouched.
    return redacted if mode == MODE_ENFORCE else messages
