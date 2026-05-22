"""M65 Slice 3B — End-to-end chaos tests for provider-flake handling.

Each test uses one of the mock-fail-* aliases shipped in M65 Slice 3A
and asserts the platform's failure-handling chain behaves correctly:

  - Gateway retries absorb transient 5xx errors
  - Errors that survive retries surface with structured codes
  - mcp-server's classification chain (M64) maps upstream status to
    LLM_PROVIDER_OVERLOADED / LLM_PROVIDER_RATE_LIMITED / etc.

Tests hit the gateway directly. A future enhancement runs the same
scenarios through mcp-server (`/mcp/invoke`) to verify the
error-code passthrough end-to-end — left as Slice 3B.next when the
mcp-server side test harness is friendlier to chaos injection.
"""
from __future__ import annotations

import time
from typing import Callable

import httpx
import pytest


# ── Happy path — sanity check the smoke harness itself ────────────────────

def test_mock_fast_returns_200(call_gateway: Callable[[str], httpx.Response]) -> None:
    """If this fails, the harness is broken (not the platform)."""
    r = call_gateway("mock-fast")
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "mock"
    assert "[mock]" in body["content"]


# ── Persistent failures — every call returns the same status ──────────────

@pytest.mark.parametrize("alias,expected_status", [
    ("mock-fail-429", 429),
    ("mock-fail-503", 503),
    ("mock-fail-529", 529),
])
def test_persistent_failure_surfaces_status(
    call_gateway: Callable[[str], httpx.Response],
    alias: str,
    expected_status: int,
) -> None:
    """Persistent (every-call) failures cleanly surface their status
    after the gateway's retry envelope is exhausted. The body carries
    an Anthropic-shaped error envelope so downstream classifiers can
    pick up the right inner type."""
    r = call_gateway(alias, timeout=180.0)
    assert r.status_code == expected_status, (
        f"expected {expected_status}, got {r.status_code} body={r.text[:200]}"
    )
    # Verify the response body carries the Anthropic-style error
    # envelope mcp-server's M64 classifier pattern-matches against.
    body_text = r.text
    if expected_status == 529:
        assert "overloaded_error" in body_text, body_text[:300]
    elif expected_status == 429:
        assert "rate_limit_error" in body_text, body_text[:300]
    elif expected_status == 503:
        assert "Service Unavailable" in body_text, body_text[:300]


# ── Transient failures — gateway retry envelope absorbs them ──────────────

def test_transient_529_absorbed_by_retry_envelope(
    call_gateway: Callable[[str], httpx.Response],
    reset_mock_counter,
) -> None:
    """The mock-fail-529-2 alias fails the first 2 calls, then succeeds.
    Resets the gateway's mock counter first so prior test runs don't
    bleed through.

    This is the regression test for the M64 incident: if the gateway's
    retry envelope shrinks or the mcp-server timeout drops below the
    retry envelope, the third call won't reach 200 in this test's
    elapsed-time budget."""
    reset_mock_counter()  # flush per-process counter
    results = []
    for i in range(3):
        r = call_gateway("mock-fail-529-2", timeout=10.0)
        results.append(r.status_code)
        time.sleep(0.1)  # let the gateway's process settle between calls
    assert results == [529, 529, 200], f"expected [529, 529, 200], got {results}"


# ── End-to-end through audit-gov (validates the M21 event chain) ──────────

def test_persistent_failure_lands_in_audit_gov(
    call_gateway: Callable[[str], httpx.Response],
    audit_gov_url: str,
) -> None:
    """When a gateway call fails, the failure SHOULD eventually
    surface as an audit_event from mcp-server. This test calls the
    gateway directly (not through mcp-server), so it just asserts the
    gateway returned the right error — the mcp-server side is
    covered by a separate test once mcp-server is added to the chaos
    harness path.

    Smoke probe: verify audit-gov is healthy AND returns events. Doesn't
    yet assert the SPECIFIC chaos event lands (mcp-server isn't in the
    test path).
    """
    # Trigger a failure.
    r = call_gateway("mock-fail-529")
    assert r.status_code == 529

    # Smoke: audit-gov /audit/search facets endpoint responds.
    with httpx.Client(timeout=5.0) as c:
        f = c.get(f"{audit_gov_url}/api/v1/audit/search/facets")
    assert f.status_code == 200, f.text[:200]
    body = f.json()
    assert "kinds" in body
    assert "severities" in body
