"""M73-followup #93 — PII mask Python port tests.

Mirror coverage of mcp-server/src/security/{mask,pii-detector}.ts.
Both implementations must produce identical token maps on the same
input or the M75 laptop-bridge cutover will desynchronise: a stage
that pauses on a laptop run (TS token map) and resumes on a platform
run (Python token map) would see different tokens for the same PII.

Test categories:
  • detect_pii — each PII kind, overlap resolution, edge cases
  • Luhn validation for credit cards
  • mask_pii — token allocation, stability, multi-call accumulation
  • unmask_string + unmask_pii_in_args — round-trip with literal-token
    leakage
  • mask_pii_in_result — recursive walk over dict/list/tuple/scalar
  • parity contract: same input → same token shape as TS
"""
from __future__ import annotations

from context_api_service.app.governed.pii_mask import (
    PiiMatch,
    _luhn_valid,
    _resolve_overlaps,
    detect_pii,
    mask_pii,
    mask_pii_in_result,
    unmask_pii_in_args,
    unmask_string,
)


# ── detect_pii ────────────────────────────────────────────────────────────


def test_detect_email():
    matches = detect_pii("contact me at a@b.com please")
    assert [m.kind for m in matches] == ["email"]
    assert matches[0].value == "a@b.com"


def test_detect_ssn():
    matches = detect_pii("SSN 123-45-6789 on file")
    assert [m.kind for m in matches] == ["ssn"]
    assert matches[0].value == "123-45-6789"


def test_detect_phone_with_country_code():
    for s in ["+1 415-555-1234", "415-555-1234", "(415) 555-1234"]:
        matches = detect_pii(f"call {s} tonight")
        assert any(m.kind == "phone" for m in matches), f"failed: {s}"


def test_detect_zip_plus_9_not_classified_as_ssn():
    """A 5+4 zip code (12345-6789) should NOT be misread as a 3+2+4
    SSN. Pattern ordering + overlap resolution handles this."""
    matches = detect_pii("Mail to 90210-1234")
    kinds = {m.kind for m in matches}
    assert "zip9" in kinds
    assert "ssn" not in kinds


def test_detect_ipv4():
    matches = detect_pii("Server at 192.168.1.42 is up")
    assert any(m.kind == "ip" and m.value == "192.168.1.42" for m in matches)


def test_detect_ipv4_rejects_versions():
    """1.2.3.4.5 is a version string, not an IP. Word-boundary regex
    keeps it out."""
    matches = detect_pii("version 1.2.3.4.5 is here")
    # Note: the regex CAN match 2.3.4.5 inside if word-boundary lands —
    # check that we don't catch the full 5-octet string.
    full = [m.value for m in matches if m.kind == "ip"]
    assert "1.2.3.4.5" not in full


def test_detect_overlap_keeps_longest():
    """Two regexes match adjacent spans of the same text — resolver
    keeps the longer one."""
    # Build matches by hand to test resolve_overlaps in isolation
    overlapping = [
        PiiMatch(kind="email", value="short", start=0, end=5),
        PiiMatch(kind="email", value="longer span", start=0, end=11),
        PiiMatch(kind="email", value="elsewhere", start=20, end=29),
    ]
    out = _resolve_overlaps(overlapping)
    # Longer-at-same-start wins; non-overlapping kept.
    assert {(m.start, m.end) for m in out} == {(0, 11), (20, 29)}


def test_detect_empty_input():
    assert detect_pii("") == []
    assert detect_pii("no PII here whatsoever") == []


# ── Luhn validation ──────────────────────────────────────────────────────


def test_luhn_accepts_valid_test_card():
    # Standard test number (Visa test): passes Luhn
    assert _luhn_valid("4111111111111111") is True


def test_luhn_rejects_invalid():
    assert _luhn_valid("4111111111111112") is False  # off-by-one
    assert _luhn_valid("1234567890123456") is False


def test_luhn_rejects_too_short_or_long():
    assert _luhn_valid("411111111111") is False    # 12 digits
    assert _luhn_valid("41111111111111111111") is False  # 20 digits


def test_detect_credit_card_filters_via_luhn():
    """A random 13-19 digit string MUST not be flagged as a credit
    card unless it passes Luhn. Otherwise zip codes, phone numbers,
    and IDs would all get masked."""
    matches = detect_pii("ID number 1234567890123456 (random)")
    assert not any(m.kind == "credit_card" for m in matches)

    matches = detect_pii("card 4111111111111111 expires next year")
    assert any(m.kind == "credit_card" for m in matches)


# ── mask_pii ─────────────────────────────────────────────────────────────


def test_mask_returns_unchanged_when_no_pii():
    r = mask_pii("plain old text", {})
    assert r.masked == "plain old text"
    assert r.token_map == {}
    assert r.applied == []


def test_mask_replaces_email_with_token():
    r = mask_pii("Reply to a@b.com today", {})
    assert "[EMAIL_1]" in r.masked
    assert "a@b.com" not in r.masked
    assert r.token_map == {"[EMAIL_1]": "a@b.com"}
    assert r.applied == [{"kind": "email", "token": "[EMAIL_1]", "count": 1}]


def test_mask_token_allocation_is_document_ordered():
    """[EMAIL_1] is the FIRST email in document order, [EMAIL_2] the
    second — same as mask.ts:maskPii's two-pass design."""
    r = mask_pii("first a@b.com then c@d.com again a@b.com", {})
    # a@b.com appears first (start=9) and again (later) — reused as
    # EMAIL_1. c@d.com (start=24) is the second distinct email.
    assert r.token_map == {"[EMAIL_1]": "a@b.com", "[EMAIL_2]": "c@d.com"}
    assert r.masked.count("[EMAIL_1]") == 2
    assert r.masked.count("[EMAIL_2]") == 1


def test_mask_same_value_reuses_token_across_calls():
    """Calling mask_pii twice with the same token_map should produce
    the same token for the same value — preserves identity across
    turns. This is the multi-turn property that the M71 cutover broke."""
    r1 = mask_pii("from a@b.com", {})
    r2 = mask_pii("also a@b.com", r1.token_map)
    assert r2.token_map["[EMAIL_1]"] == "a@b.com"
    # No new token allocated
    assert "[EMAIL_2]" not in r2.token_map


def test_mask_uses_max_plus_one_not_count():
    """Deleted token numbers don't get reused — preserves audit trail
    even if the operator UI later removes a token mapping."""
    starting = {
        "[EMAIL_1]": "old@a.com",
        "[EMAIL_3]": "kept@b.com",
        # EMAIL_2 deleted
    }
    r = mask_pii("new email z@x.com", starting)
    # Next allocation is EMAIL_4, not EMAIL_2
    assert "[EMAIL_4]" in r.token_map
    assert r.token_map["[EMAIL_4]"] == "z@x.com"


def test_mask_different_kinds_have_independent_counters():
    """A phone and a credit card with overlapping digits should never
    share a token — different kinds, different prefixes."""
    r = mask_pii("phone 415-555-1234 card 4111111111111111", {})
    assert "[PHONE_1]" in r.token_map
    assert "[CARD_1]" in r.token_map


def test_mask_applied_diagnostic_has_no_values():
    """Audit events embed `applied` — must never contain actual PII
    values, only counts + kinds + tokens."""
    r = mask_pii("a@b.com c@d.com phone 415-555-1234", {})
    for entry in r.applied:
        assert "value" not in entry
        # The token itself is fine (it's the redacted form)
        assert entry["count"] >= 1


# ── unmask_string ────────────────────────────────────────────────────────


def test_unmask_replaces_known_tokens():
    out = unmask_string(
        "send to [EMAIL_1] and copy [EMAIL_2]",
        {"[EMAIL_1]": "a@b.com", "[EMAIL_2]": "c@d.com"},
    )
    assert "a@b.com" in out
    assert "c@d.com" in out
    assert "[EMAIL_1]" not in out


def test_unmask_leaves_unknown_tokens_as_literals():
    """Model might invent a token like [EMAIL_99] that's not in the
    map. Leaving it as-is is safer than guessing or stripping."""
    out = unmask_string(
        "real [EMAIL_1] and fake [EMAIL_99]",
        {"[EMAIL_1]": "a@b.com"},
    )
    assert "a@b.com" in out
    assert "[EMAIL_99]" in out


def test_unmask_handles_overlap_correctly():
    """If both [EMAIL_1] and [EMAIL_10] are in the map, [EMAIL_10]
    must win at its match site — sort-longest-first ensures this."""
    out = unmask_string(
        "[EMAIL_10] then [EMAIL_1]",
        {"[EMAIL_1]": "first@x.com", "[EMAIL_10]": "tenth@y.com"},
    )
    assert "tenth@y.com" in out
    assert "first@x.com" in out


def test_unmask_empty_or_no_map():
    assert unmask_string("", {"[EMAIL_1]": "x@y.com"}) == ""
    assert unmask_string("text", {}) == "text"


# ── unmask_pii_in_args ───────────────────────────────────────────────────


def test_unmask_args_walks_dict():
    args = {
        "to": "[EMAIL_1]",
        "subject": "fyi for [PHONE_1]",
        "nested": {"cc": "[EMAIL_2]"},
    }
    out = unmask_pii_in_args(args, {
        "[EMAIL_1]": "a@b.com",
        "[EMAIL_2]": "c@d.com",
        "[PHONE_1]": "415-555-1234",
    })
    assert out["to"] == "a@b.com"
    assert out["nested"]["cc"] == "c@d.com"
    assert "415-555-1234" in out["subject"]


def test_unmask_args_walks_list():
    args = {"recipients": ["[EMAIL_1]", "[EMAIL_2]", "literal-not-a-token"]}
    out = unmask_pii_in_args(args, {"[EMAIL_1]": "a@b.com", "[EMAIL_2]": "c@d.com"})
    assert out["recipients"] == ["a@b.com", "c@d.com", "literal-not-a-token"]


def test_unmask_args_preserves_non_string_leaves():
    args = {"count": 42, "flag": True, "ratio": 3.14, "missing": None}
    out = unmask_pii_in_args(args, {"[EMAIL_1]": "x@y.com"})
    assert out == args


def test_unmask_args_does_not_mutate_input():
    args = {"to": "[EMAIL_1]"}
    unmask_pii_in_args(args, {"[EMAIL_1]": "x@y.com"})
    # Input dict still has the token
    assert args["to"] == "[EMAIL_1]"


# ── mask_pii_in_result ───────────────────────────────────────────────────


def test_mask_result_walks_nested_structure():
    result = {
        "messages": [
            {"from": "a@b.com", "body": "ping 415-555-1234"},
            {"from": "c@d.com", "body": "no PII here"},
        ],
        "meta": {"submitter": "z@w.com"},
    }
    masked, token_map, applied = mask_pii_in_result(result, {})

    # Every email replaced
    assert "a@b.com" not in str(masked)
    assert "c@d.com" not in str(masked)
    assert "z@w.com" not in str(masked)
    assert "415-555-1234" not in str(masked)

    # Same email → same token across leaves
    by_value = {v: k for k, v in token_map.items()}
    assert masked["messages"][0]["from"] == by_value["a@b.com"]
    assert masked["messages"][1]["from"] == by_value["c@d.com"]
    assert masked["meta"]["submitter"] == by_value["z@w.com"]

    # Diagnostic combines counts across leaves
    kinds = {e["kind"]: e["count"] for e in applied}
    assert kinds["email"] == 3
    assert kinds["phone"] == 1


def test_mask_result_extends_existing_token_map():
    """Calling mask_pii_in_result with a prior token map preserves
    earlier mappings and continues numbering from the max."""
    prior = {"[EMAIL_1]": "old@example.com"}
    result = {"to": "new@example.com"}
    masked, token_map, _ = mask_pii_in_result(result, prior)
    assert token_map["[EMAIL_1]"] == "old@example.com"
    assert "[EMAIL_2]" in token_map


def test_mask_result_handles_none_and_scalars():
    assert mask_pii_in_result(None, {}) == (None, {}, [])
    assert mask_pii_in_result(42, {}) == (42, {}, [])
    masked, _, _ = mask_pii_in_result(True, {})
    assert masked is True


def test_mask_result_returns_empty_applied_when_no_pii():
    result = {"status": "ok", "count": 0}
    masked, token_map, applied = mask_pii_in_result(result, {})
    assert masked == result
    assert applied == []
    assert token_map == {}


# ── round-trip property ──────────────────────────────────────────────────


def test_mask_unmask_roundtrip_for_args():
    """Mask a tool output, then send the LLM a tool call whose args
    parrot those tokens, then unmask before dispatch — the original
    PII flows through unchanged. This is the property the multi-turn
    feature was designed for."""
    tool_output = {
        "from": "support@x.com",
        "phone": "415-555-9999",
        "body": "Reply to support@x.com please",
    }
    masked_output, token_map, _ = mask_pii_in_result(tool_output, {})
    # LLM sees masked_output; emits a tool call referencing those tokens.
    llm_args = {
        "to": masked_output["from"],          # [EMAIL_1]
        "cc": [masked_output["phone"]],       # [PHONE_1]
    }
    # Pre-dispatch unmask resolves them back to real values.
    real_args = unmask_pii_in_args(llm_args, token_map)
    assert real_args == {"to": "support@x.com", "cc": ["415-555-9999"]}


def test_mask_applied_diagnostic_combines_recursive_counts():
    """A list of 3 strings each containing 2 emails → applied reports
    email count = 6, not 3."""
    result = ["a@b.com c@d.com", "e@f.com g@h.com", "i@j.com k@l.com"]
    _, _, applied = mask_pii_in_result(result, {})
    kinds = {e["kind"]: e["count"] for e in applied}
    assert kinds["email"] == 6
