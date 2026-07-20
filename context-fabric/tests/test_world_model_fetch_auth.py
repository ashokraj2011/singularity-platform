"""
Contract: the world-model fetches authenticate.

Both fetches sent no Authorization header. That was invisible for as long as a
second bug hid it: the URL omitted the `/api/v1` prefix, so every request 404'd,
and 404 has an explicit "not generated yet, not a failure" branch. Fixing the URL
did not deliver the world model — it moved the failure from 404 to 401, which
falls into the generic HTTPStatusError handler and produces the same quiet
`world_model.skipped` outcome.

Measured against a running stack, which is the only reason this was caught:

    GET /capabilities/…          -> 404   (route absent; the original bug)
    GET /api/v1/capabilities/…   -> 401   (route present, auth required)

agent-runtime gates that router with `requireAuth`, which accepts a service
principal (`servicePrincipalFromToken`, auth.middleware.ts:123), and CF already
holds `settings.iam_service_token`.

The assertions below are about the CALL SITES. A test that exercised the header
helper alone would pass while a fetch forgot to pass it — which is exactly the
shape of the original defect.
"""
from __future__ import annotations

import re
from pathlib import Path

SRC = (
    Path(__file__).resolve().parents[1]
    / "services" / "context_api_service" / "app" / "execute_modules" / "prompt_context.py"
).read_text()


def test_no_unauthenticated_get_to_agent_runtime_remains():
    """The regression guard: every GET in this module carries headers.

    Written as "no bare GET" rather than "these two GETs are patched" so a third
    fetch added later cannot quietly ship unauthenticated.
    """
    bare = [
        m.group(0)
        for m in re.finditer(r"client\.get\((?![^)]*headers=)[^)]*\)", SRC)
    ]
    assert not bare, f"unauthenticated GET(s) to agent-runtime: {bare}"


def test_both_world_model_fetches_send_the_header():
    assert SRC.count("headers=_agent_runtime_headers()") == 2


def test_header_helper_reads_the_service_token():
    assert "settings.iam_service_token" in SRC


def test_absent_token_degrades_rather_than_sending_a_broken_header():
    # A deployment running agent-runtime without auth must keep working, and
    # `Bearer ` with an empty token is worse than no header — it authenticates
    # as nothing while looking deliberate.
    helper = SRC[SRC.index("def _agent_runtime_headers"):]
    helper = helper[: helper.index("\n\n\n")] if "\n\n\n" in helper else helper
    assert "if token else None" in helper


def test_the_404_branch_is_still_distinguished_from_other_failures():
    # 404 genuinely means "no world model generated yet" and must stay a
    # non-failure. The point of this change is that 401 is NOT that, and must
    # not be silently equivalent to it.
    assert "resp.status_code == 404" in SRC
    assert "not yet generated (404)" in SRC


def test_api_v1_prefix_is_used():
    # The other half of the same bug — guard both, since fixing either alone
    # leaves the world model undelivered.
    assert SRC.count("agent_runtime_api_base(") >= 2
