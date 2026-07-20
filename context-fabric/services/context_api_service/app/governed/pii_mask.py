"""
M73-followup #93 — CF-side PII mask + unmask for the governed loop.

Closes the regression documented in
``context-fabric/docs/M73-pii-regression.md``. Mirrors the mcp-server
TypeScript implementation (``mcp-server/src/security/mask.ts`` +
``pii-detector.ts``) so the two paths produce identical token maps
on the same input. That symmetry matters during the M75 cutover:
laptop runs were using the TS implementation locally; platform runs
will now use this one. Both must agree on token shape so audit-gov
events from either path are joinable.

Scope: regex-based detection only — SSN, email, phone, credit-card
(Luhn-validated), ZIP+9, IPv4. NER (person / org / location) lives
in mcp-server's pii-ner.ts and stays there; CF doesn't run the NER
model. Capability parity with the TS regex path is what the
governed-loop cutover needs to ship.

The mask/unmask is invoked by ``governed.loop.governed_step``:

  pre-dispatch:  args = unmask_pii_in_args(args, state.pii_token_map)
                 # LLM may have emitted tokens like [EMAIL_1]; the
                 # tool downstream expects the real email.
  post-dispatch: result, new_map, applied = mask_pii_in_result(
                     outcome.result, state.pii_token_map)
                 # tool output goes back to LLM with PII tokenised.

The token map persists in PhaseState.pii_token_map across turns AND
across pause/resume — operator-curated tokens stay stable for the
whole stage so the model can reason about identity (e.g. "[EMAIL_1]
is the same address the user mentioned three turns ago").

What this does NOT do (deliberately):

  • NER detection (people, orgs, locations). Add when CF has an
    inference budget for it; today the regex baseline is what
    mcp-server's regex path catches too.
  • Strip-on-suspicion. We never drop content — only tokenise. False
    positives are recoverable via the operator UI; false negatives
    show up in audit-gov's pii.masked event stream.
  • Per-provider variation. The token format ``[KIND_N]`` is
    universal across Anthropic / OpenAI / mock providers.
"""
from __future__ import annotations

import re
from collections.abc import Collection
from dataclasses import dataclass, field
from typing import Any, Literal


PiiKind = Literal[
    "ssn", "email", "phone", "credit_card", "zip9", "ip",
    "person", "org", "location",
]


@dataclass(frozen=True)
class PiiMatch:
    """One detected PII span. Document-ordered, non-overlapping after
    resolve_overlaps()."""
    kind: PiiKind
    value: str
    start: int
    end: int
    confidence: float = 1.0


# Detection patterns. Order matters for overlap resolution: more-specific
# patterns (SSN, ZIP+9) come first so they win the keep loop. Mirror of
# pii-detector.ts:PATTERNS.
_PATTERNS: list[tuple[PiiKind, "re.Pattern[str]"]] = [
    # SSN: NNN-NN-NNNN — match before ZIP+9 (different boundary).
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    # ZIP+9 — five digits, hyphen, four digits.
    ("zip9", re.compile(r"\b\d{5}-\d{4}\b")),
    # Email — practical RFC-ish pattern.
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    # Phone — NANP, optional +1.
    ("phone", re.compile(
        r"\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b"
    )),
    # Credit card — 13–19 digits w/ optional separators. Luhn-validated below.
    ("credit_card", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    # IPv4 — strict dotted quads with 0–255 components.
    ("ip", re.compile(
        r"\b(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)"
        r"(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}\b"
    )),
]


def _luhn_valid(s: str) -> bool:
    """Standard Luhn checksum, used to reject random 13–19 digit groups
    that aren't real credit cards. Matches pii-detector.ts:luhnValid."""
    digits = re.sub(r"\D", "", s)
    if len(digits) < 13 or len(digits) > 19:
        return False
    total = 0
    alternate = False
    for ch in reversed(digits):
        n = int(ch)
        if alternate:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alternate = not alternate
    return total % 10 == 0


def _resolve_overlaps(matches: list[PiiMatch]) -> list[PiiMatch]:
    """Keep the longest match at any overlapping position; tie-break by
    earliest start. Mirrors pii-detector.ts:resolveOverlaps."""
    if not matches:
        return matches
    # Sort: start ASC, end DESC (longest-at-same-start wins the loop).
    sorted_matches = sorted(matches, key=lambda m: (m.start, -m.end))
    out: list[PiiMatch] = []
    for m in sorted_matches:
        if out and m.start < out[-1].end:
            continue  # overlap with a longer span we already kept
        out.append(m)
    return out


def detect_pii(
    text: str, kinds: Collection[PiiKind] | None = None,
) -> list[PiiMatch]:
    """Run the regex detectors against ``text``, return non-overlapping
    matches in document order. Each match has confidence 1.0 except
    credit cards which additionally pass Luhn (failures simply don't
    appear in the output).

    ``kinds`` restricts which detectors run. None (the default) means ALL
    of them, so every existing caller — the tool-output mask at
    loop.py:868 — is unchanged. The filter exists for outbound_pii.py,
    which deliberately runs a narrower, higher-precision subset against
    prompt text; see that module for why breadth is the wrong default on
    the egress path.

    Filtering happens BEFORE overlap resolution, which is the correct
    order: a suppressed detector must not go on winning an overlap
    against a detector the caller actually asked for.
    """
    if not text:
        return []
    raw: list[PiiMatch] = []
    for kind, pattern in _PATTERNS:
        if kinds is not None and kind not in kinds:
            continue
        for m in pattern.finditer(text):
            value = m.group(0)
            if kind == "credit_card" and not _luhn_valid(value):
                continue
            raw.append(PiiMatch(
                kind=kind,
                value=value,
                start=m.start(),
                end=m.end(),
                confidence=1.0,
            ))
    return _resolve_overlaps(raw)


# ── token map machinery ───────────────────────────────────────────────────

_KIND_TO_PREFIX: dict[PiiKind, str] = {
    "ssn": "SSN",
    "email": "EMAIL",
    "phone": "PHONE",
    "credit_card": "CARD",
    "zip9": "ZIP",
    "ip": "IP",
    "person": "PERSON",
    "org": "ORG",
    "location": "LOCATION",
}

_TOKEN_RE = re.compile(r"^\[([A-Z]+)_(\d+)\]$")


def _kind_prefix(kind: PiiKind) -> str:
    return _KIND_TO_PREFIX.get(kind, "PII")


def _find_existing_token(
    token_map: dict[str, str], kind: PiiKind, value: str,
) -> str | None:
    """Reverse lookup: value → existing token, scoped to a kind so a
    phone and credit card with overlapping digits never share a token."""
    prefix = f"[{_kind_prefix(kind)}_"
    for token, v in token_map.items():
        if token.startswith(prefix) and v == value:
            return token
    return None


def _next_token(token_map: dict[str, str], kind: PiiKind) -> str:
    """Allocate the next sequential token for a kind. Uses max+1 so
    deletions don't reuse numbers — preserves the audit trail."""
    prefix = _kind_prefix(kind)
    max_n = 0
    for tok in token_map.keys():
        m = _TOKEN_RE.match(tok)
        if m and m.group(1) == prefix:
            try:
                n = int(m.group(2))
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"[{prefix}_{max_n + 1}]"


@dataclass
class MaskResult:
    """Outcome of one mask_pii call. Mirrors mask.ts:MaskResult."""
    masked: str
    token_map: dict[str, str]
    applied: list[dict[str, Any]] = field(default_factory=list)


def mask_pii(
    text: str,
    token_map: dict[str, str] | None = None,
    kinds: Collection[PiiKind] | None = None,
) -> MaskResult:
    """Replace detected PII spans in ``text`` with stable tokens. Same
    (kind, value) always maps to the same token across calls within the
    given token_map. Returns the masked text, the updated token map
    (existing entries preserved + new ones appended), and a diagnostic
    list of what got masked this call (no values — counts only).

    ``kinds`` is forwarded to detect_pii(); None means all detectors, so
    existing callers are unchanged.

    Pure function: input ``token_map`` is not mutated. Caller assigns
    ``result.token_map`` back to its state.
    """
    if not text:
        return MaskResult(masked=text or "", token_map=dict(token_map or {}))
    matches = detect_pii(text, kinds)
    if not matches:
        return MaskResult(masked=text, token_map=dict(token_map or {}))

    new_map: dict[str, str] = dict(token_map or {})
    # Pass 1 (forward): allocate tokens in document order so [EMAIL_1]
    # is always the first email in the text. Stored separately from the
    # splice pass because allocation order matters for stability.
    tokens: list[str] = []
    for m in matches:
        existing = _find_existing_token(new_map, m.kind, m.value)
        if existing is None:
            allocated = _next_token(new_map, m.kind)
            new_map[allocated] = m.value
            tokens.append(allocated)
        else:
            tokens.append(existing)

    # Pass 2 (reverse): splice right-to-left so earlier string indexes
    # stay valid as we mutate. Same trick as mask.ts.
    out = text
    tally: dict[PiiKind, dict[str, Any]] = {}
    for i in range(len(matches) - 1, -1, -1):
        m = matches[i]
        token = tokens[i]
        out = out[: m.start] + token + out[m.end :]
        if m.kind in tally:
            tally[m.kind]["count"] += 1
        else:
            tally[m.kind] = {"kind": m.kind, "token": token, "count": 1}

    applied = list(tally.values())
    return MaskResult(masked=out, token_map=new_map, applied=applied)


def unmask_string(text: str, token_map: dict[str, str]) -> str:
    """Replace any ``[KIND_N]`` token in ``text`` with its real value
    from ``token_map``. Tokens not present in the map are left as-is —
    safer than guessing. Mirrors mask.ts:unmaskString."""
    if not text or not token_map:
        return text
    # Sort longest-first so [EMAIL_10] wins over [EMAIL_1] when
    # iterating. Regex alternation is greedy at the level of the
    # alternatives — sorting handles the rest.
    tokens = sorted(token_map.keys(), key=len, reverse=True)
    if not tokens:
        return text
    pattern = re.compile("|".join(re.escape(t) for t in tokens))
    return pattern.sub(lambda m: token_map.get(m.group(0), m.group(0)), text)


def unmask_pii_in_args(args: Any, token_map: dict[str, str]) -> Any:
    """Walk an arbitrary JSON-like value and apply unmask_string() to
    every string descendant. Returns a deep-copied result so the caller
    can safely log the pre-unmask args too — never mutates the input.
    Mirrors mask.ts:unmaskPiiInArgs."""
    if args is None:
        return None
    if isinstance(args, str):
        return unmask_string(args, token_map)
    if isinstance(args, list):
        return [unmask_pii_in_args(v, token_map) for v in args]
    if isinstance(args, tuple):
        return tuple(unmask_pii_in_args(v, token_map) for v in args)
    if isinstance(args, dict):
        return {k: unmask_pii_in_args(v, token_map) for k, v in args.items()}
    # int / float / bool / etc. pass through unchanged.
    return args


def mask_pii_in_result(
    result: Any, token_map: dict[str, str] | None = None,
) -> tuple[Any, dict[str, str], list[dict[str, Any]]]:
    """Recursive analogue of unmask_pii_in_args, but in the mask
    direction. Walks any JSON-like value, tokenises PII in every
    string descendant, returns the masked tree + updated token map +
    accumulated diagnostic list.

    The diagnostic list combines counts across all string leaves —
    operators see one ``pii.masked`` event per tool call with the
    total by kind, not one per string leaf.
    """
    new_map: dict[str, str] = dict(token_map or {})
    tally: dict[PiiKind, dict[str, Any]] = {}

    def _walk(value: Any) -> Any:
        nonlocal new_map
        if value is None:
            return None
        if isinstance(value, str):
            r = mask_pii(value, new_map)
            new_map = r.token_map
            for entry in r.applied:
                kind = entry["kind"]
                if kind in tally:
                    tally[kind]["count"] += entry["count"]
                else:
                    tally[kind] = {"kind": kind, "token": entry["token"], "count": entry["count"]}
            return r.masked
        if isinstance(value, list):
            return [_walk(v) for v in value]
        if isinstance(value, tuple):
            return tuple(_walk(v) for v in value)
        if isinstance(value, dict):
            return {k: _walk(v) for k, v in value.items()}
        return value

    masked = _walk(result)
    return masked, new_map, list(tally.values())
