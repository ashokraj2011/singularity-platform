"""Outbound prompt PII masking — narrow kinds, opt-in scope, shadow-first.

The tests that matter most here are the NEGATIVE ones: that phone / zip9 / ipv4
are not masked, and that shadow mode changes literally nothing including the
token map. Both encode decisions that are easy to "fix" into a regression.
"""
from __future__ import annotations

import pytest

from context_api_service.app.governed import outbound_pii
from context_api_service.app.governed.pii_mask import (
    detect_pii,
    mask_pii,
    unmask_pii_in_args,
)


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "CF_MASK_PROMPT_PII",
        "CF_MASK_PROMPT_PII_CAPABILITIES",
        "CF_MASK_PROMPT_PII_TENANTS",
    ):
        monkeypatch.delenv(name, raising=False)


def _enforce_for(monkeypatch: pytest.MonkeyPatch, *, capability: str = "cap-1") -> None:
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "enforce")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_CAPABILITIES", capability)


def _msg(content: str, role: str = "user") -> dict:
    return {"role": role, "content": content}


# ── kind narrowing ────────────────────────────────────────────────────────


def test_masks_only_the_three_high_precision_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    text = (
        "contact bob@example.com ssn 123-45-6789 card 4111 1111 1111 1111 "
        "phone 415-555-0123 zip 94105-1234 host 192.168.1.1"
    )
    out, token_map, mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert mode == "enforce"
    masked = out[0]["content"]

    # Masked.
    assert "bob@example.com" not in masked
    assert "123-45-6789" not in masked
    assert "4111 1111 1111 1111" not in masked

    # NOT masked — deliberately. See outbound_pii's module docstring: on the
    # egress path these three corrupt prompts far more often than they protect
    # anything, and the corruption is silent.
    assert "415-555-0123" in masked
    assert "94105-1234" in masked
    assert "192.168.1.1" in masked

    kinds = {f["kind"] for f in findings}
    assert kinds == {"ssn", "email", "credit_card"}


def test_ipv4_lookalikes_in_source_survive(monkeypatch: pytest.MonkeyPatch) -> None:
    """The regression this narrowing exists to prevent."""
    _enforce_for(monkeypatch)
    text = (
        "upgraded from 1.2.3.4 to 10.0.0.255; bind 127.0.0.1:8080; "
        "netmask 255.255.255.0; offsets 192.168.1.1"
    )
    out, _map, _mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert out[0]["content"] == text
    assert findings == []


def test_credit_card_requires_luhn(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    # Right shape, fails the checksum -> not a card, not masked.
    text = "trace id 4111111111111112 in the log"
    out, _map, _mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert out[0]["content"] == text
    assert findings == []


def test_detect_pii_kind_filter_does_not_change_default_behaviour() -> None:
    """The `kinds` argument added to pii_mask must be inert when omitted, or the
    tool-output mask at loop.py:868 silently narrows too."""
    text = "a@b.co 123-45-6789 415-555-0123 94105-1234 192.168.1.1"
    all_kinds = {m.kind for m in detect_pii(text)}
    assert {"email", "ssn", "phone", "zip9", "ip"} <= all_kinds

    narrowed = {m.kind for m in detect_pii(text, outbound_pii.OUTBOUND_PII_KINDS)}
    assert narrowed == {"email", "ssn"}


def test_filtered_detector_does_not_lose_a_span_to_a_suppressed_one() -> None:
    """Overlap resolution must run AFTER filtering. zip9 is listed before email
    in _PATTERNS; a suppressed kind must not go on winning overlaps."""
    text = "zip 94105-1234 and ssn 123-45-6789"
    narrowed = detect_pii(text, ("ssn",))
    assert [m.value for m in narrowed] == ["123-45-6789"]


# ── scope opt-in ──────────────────────────────────────────────────────────


def test_default_is_off_with_no_configuration() -> None:
    text = "bob@example.com and 123-45-6789"
    out, token_map, mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1", tenant_id="tenant-1",
    )
    assert mode == "off"
    assert out[0]["content"] == text
    assert token_map == {}
    assert findings == []


def test_mode_without_a_named_scope_stays_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt-IN means somebody named a capability or tenant. A mode left set with
    no scope must not quietly enable it fleet-wide."""
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "enforce")
    out, _map, mode, _findings = outbound_pii.apply_to_messages(
        [_msg("bob@example.com")], capability_id="cap-1", tenant_id="tenant-1",
    )
    assert mode == "off"
    assert out[0]["content"] == "bob@example.com"


def test_scope_matches_on_capability_or_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "enforce")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_CAPABILITIES", "cap-a,cap-b")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_TENANTS", "tenant-x")

    assert outbound_pii.effective_mode("cap-b", None) == "enforce"
    assert outbound_pii.effective_mode(None, "tenant-x") == "enforce"
    assert outbound_pii.effective_mode("cap-z", "tenant-z") == "off"


def test_wildcard_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "shadow")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_TENANTS", "*")
    assert outbound_pii.effective_mode("anything", "anyone") == "shadow"


def test_unknown_mode_falls_back_to_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "enfroce")  # typo
    monkeypatch.setenv("CF_MASK_PROMPT_PII_CAPABILITIES", "*")
    assert outbound_pii.effective_mode("cap-1", None) == "off"


def test_scope_from_run_context_accepts_both_spellings() -> None:
    assert outbound_pii.scope_from_run_context(
        {"capability_id": "c1", "tenant_id": "t1"}
    ) == ("c1", "t1")
    assert outbound_pii.scope_from_run_context(
        {"capabilityId": "c2", "tenantId": "t2"}
    ) == ("c2", "t2")
    assert outbound_pii.scope_from_run_context({"orgId": "t3"}) == (None, "t3")
    assert outbound_pii.scope_from_run_context(None) == (None, None)


# ── shadow mode changes nothing ───────────────────────────────────────────


def test_shadow_reports_but_does_not_modify_the_prompt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "shadow")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_CAPABILITIES", "cap-1")
    text = "bob@example.com and 123-45-6789"
    out, token_map, mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert mode == "shadow"
    assert out[0]["content"] == text
    assert {f["kind"] for f in findings} == {"email", "ssn"}
    # The whole point: findings exist, nothing changed.
    assert token_map == {}


def test_shadow_must_not_mint_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    """If shadow grew the token map, unmask_pii_in_args would start rewriting
    literal [EMAIL_1] strings the model never received a mask for."""
    monkeypatch.setenv("CF_MASK_PROMPT_PII", "shadow")
    monkeypatch.setenv("CF_MASK_PROMPT_PII_CAPABILITIES", "cap-1")
    existing = {"[EMAIL_1]": "prior@example.com"}
    _out, token_map, _mode, _findings = outbound_pii.apply_to_messages(
        [_msg("new bob@example.com")], token_map=existing, capability_id="cap-1",
    )
    assert token_map == existing


# ── the round trip ────────────────────────────────────────────────────────


def test_enforce_grows_the_token_map_so_tool_args_can_be_unmasked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The load-bearing property. A model that echoes a prompt token into a tool
    argument must get the real value back at dispatch."""
    _enforce_for(monkeypatch)
    out, token_map, mode, _findings = outbound_pii.apply_to_messages(
        [_msg("email bob@example.com about the outage")], capability_id="cap-1",
    )
    assert mode == "enforce"
    masked = out[0]["content"]
    assert "[EMAIL_1]" in masked

    # The model faithfully echoes the token it was shown.
    tool_args = {"to": "[EMAIL_1]", "subject": "outage"}
    # ...and loop.py:708/786 reverses it against the SAME map.
    assert unmask_pii_in_args(tool_args, token_map) == {
        "to": "bob@example.com",
        "subject": "outage",
    }


def test_token_map_is_stable_across_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same value -> same token, so the model can reason about identity across
    turns ('the address you mentioned earlier')."""
    _enforce_for(monkeypatch)
    first, map_one, _mode, _f = outbound_pii.apply_to_messages(
        [_msg("bob@example.com")], capability_id="cap-1",
    )
    second, map_two, _mode2, _f2 = outbound_pii.apply_to_messages(
        [_msg("again bob@example.com")], token_map=map_one, capability_id="cap-1",
    )
    assert first[0]["content"] == "[EMAIL_1]"
    assert second[0]["content"] == "again [EMAIL_1]"
    assert map_two == map_one


def test_existing_tool_output_tokens_are_reused_not_reallocated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """History already contains tokens from the tool-output mask (loop.py:868).
    Masking the prompt must join that map, not start a second numbering."""
    _enforce_for(monkeypatch)
    prior = mask_pii("from a tool: bob@example.com").token_map
    assert prior == {"[EMAIL_1]": "bob@example.com"}

    out, token_map, _mode, _f = outbound_pii.apply_to_messages(
        [_msg("prompt mentions bob@example.com and carol@example.com")],
        token_map=prior,
        capability_id="cap-1",
    )
    assert token_map["[EMAIL_1]"] == "bob@example.com"
    assert token_map["[EMAIL_2]"] == "carol@example.com"
    assert "[EMAIL_1]" in out[0]["content"] and "[EMAIL_2]" in out[0]["content"]


# ── robustness ────────────────────────────────────────────────────────────


def test_non_string_content_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    blocks = [{"type": "text", "text": "bob@example.com"}]
    out, _map, _mode, findings = outbound_pii.apply_to_messages(
        [{"role": "user", "content": blocks}], capability_id="cap-1",
    )
    # Unfamiliar shapes are passed through rather than restructured.
    assert out[0]["content"] is blocks
    assert findings == []


def test_inputs_are_never_mutated(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    original = [_msg("bob@example.com")]
    token_map: dict[str, str] = {}
    out, new_map, _mode, _f = outbound_pii.apply_to_messages(
        original, token_map=token_map, capability_id="cap-1",
    )
    assert original[0]["content"] == "bob@example.com"
    assert token_map == {}
    assert out[0]["content"] != original[0]["content"]
    assert new_map != token_map


def test_masking_failure_degrades_to_sending_the_original(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bug in masking must not take down the governed loop."""
    _enforce_for(monkeypatch)

    def _boom(*_a, **_kw):
        raise RuntimeError("bob@example.com")  # message quotes PII on purpose

    monkeypatch.setattr(outbound_pii, "mask_messages", _boom)
    text = "bob@example.com"
    out, token_map, mode, findings = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert out[0]["content"] == text
    assert mode == "off"
    assert token_map == {}
    assert findings == []


def test_findings_never_carry_the_matched_value(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    _out, _map, _mode, findings = outbound_pii.apply_to_messages(
        [_msg("bob@example.com ssn 123-45-6789")], capability_id="cap-1",
    )
    assert findings
    for finding in findings:
        assert set(finding.keys()) == {"kind", "count"}
        serialized = repr(finding)
        assert "bob@example.com" not in serialized
        assert "123-45-6789" not in serialized


def test_findings_order_is_stable(monkeypatch: pytest.MonkeyPatch) -> None:
    _enforce_for(monkeypatch)
    text = "123-45-6789 then bob@example.com"
    _out, _map, _mode, first = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    _out2, _map2, _mode2, second = outbound_pii.apply_to_messages(
        [_msg(text)], capability_id="cap-1",
    )
    assert first == second
    # Kind order, not match order.
    assert [f["kind"] for f in first] == ["ssn", "email"]
