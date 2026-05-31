"""M99 S2.1 — platform-driven auto-baseline synthesis + run_stage wiring."""
import pytest

from context_api_service.app.governed import auto_baseline as ab
from context_api_service.app.governed import stage_driver as sd
from context_api_service.app.governed.baseline_diff import BASELINE_STASH_KEY, get_stashed_baseline
from context_api_service.app.governed.dispatch import ToolDispatchError
from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.receipts import BaselineReceipt, ReceiptKind
from context_api_service.app.governed.stage_execution_policy import StageExecutionPolicy

_ENV = "CF_AUTO_BASELINE_ENABLED"
_RECEIPT_KEY = "__baseline_receipt__"


class _FakeOutcome:
    def __init__(self, result, tool_success=True, tool_error=None):
        self.result = result
        self.tool_success = tool_success
        self.tool_error = tool_error
        self.duration_ms = 1
        self.tool_invocation_id = "inv"


def _patch_dispatch(monkeypatch, *, rec=None, baseline=None):
    """rec/baseline: _FakeOutcome | Exception keyed by tool name."""
    async def fake_dispatch(tool_name, args, **kwargs):
        r = rec if tool_name == "recommended_verification" else baseline
        if isinstance(r, Exception):
            raise r
        return r
    monkeypatch.setattr(ab, "dispatch_tool", fake_dispatch)


@pytest.mark.asyncio
async def test_baseline_captures_and_stashes(monkeypatch):
    _patch_dispatch(
        monkeypatch,
        rec=_FakeOutcome({"recommended": [{"command": "pytest -q", "runnable": True}]}),
        baseline=_FakeOutcome({"parsed_tests": {"failingTests": ["test_a", "test_b"], "totalTests": 10}}),
    )
    receipts: dict = {}
    res = await ab.synthesize_baseline(
        state_receipts=receipts, work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.captured is True
    assert res.failing_tests == ["test_a", "test_b"]
    assert res.commands_run == ["pytest -q"]
    # stashed in the shape get_stashed_baseline / enrich_verification_receipt expects
    stash = get_stashed_baseline(receipts)
    assert stash is not None
    failing, total = stash
    assert failing == {"test_a", "test_b"} and total == 10
    BaselineReceipt(**res.to_receipt_payload())  # round-trips


@pytest.mark.asyncio
async def test_baseline_no_runnable_verifier(monkeypatch):
    _patch_dispatch(
        monkeypatch,
        rec=_FakeOutcome({"recommended": [{"command": "x", "runnable": False}], "guidance": "none runnable"}),
        baseline=_FakeOutcome({}),
    )
    receipts: dict = {}
    res = await ab.synthesize_baseline(
        state_receipts=receipts, work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.captured is False
    assert res.reason == "none runnable"
    assert BASELINE_STASH_KEY not in receipts


@pytest.mark.asyncio
async def test_baseline_dispatch_error_swallowed(monkeypatch):
    _patch_dispatch(monkeypatch, rec=ToolDispatchError("boom"), baseline=None)
    res = await ab.synthesize_baseline(
        state_receipts={}, work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.captured is False
    assert res.reason is not None


# ── run_stage wiring ───────────────────────────────────────────────────────────

async def _noop_emit(**kwargs):
    return None


def _state():
    return PhaseState(stage_key="DEVELOP", agent_role="DEVELOPER", current_phase=Phase.PLAN)


@pytest.mark.asyncio
async def test_wiring_noop_when_env_disabled(monkeypatch):
    monkeypatch.delenv(_ENV, raising=False)
    called = {"x": False}

    async def fake(**kwargs):
        called["x"] = True
        return ab.BaselineResult(captured=True)
    monkeypatch.setattr(sd, "synthesize_baseline", fake)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    await sd._maybe_run_auto_baseline(
        state=state, run_context={}, bearer=None,
        exec_policy=StageExecutionPolicy(stage_key="DEVELOP", auto_baseline=True),
        stage_policy=None,
    )
    assert called["x"] is False
    assert _RECEIPT_KEY not in state.receipts


@pytest.mark.asyncio
async def test_wiring_stashes_receipt_when_enabled(monkeypatch):
    monkeypatch.setenv(_ENV, "1")

    async def fake(**kwargs):
        # mimic a real capture that also writes the stash
        kwargs["state_receipts"][BASELINE_STASH_KEY] = [
            {"failing_tests": ["t1"], "total_tests": 3, "command": "pytest"}
        ]
        return ab.BaselineResult(captured=True, tests_ran=True, failing_tests=["t1"], commands_run=["pytest"])
    monkeypatch.setattr(sd, "synthesize_baseline", fake)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    await sd._maybe_run_auto_baseline(
        state=state, run_context={"workItemId": "wi"}, bearer=None,
        exec_policy=StageExecutionPolicy(stage_key="DEVELOP", auto_baseline=True),
        stage_policy=None,
    )
    bucket = state.receipts[_RECEIPT_KEY]
    assert len(bucket) == 1
    assert bucket[0]["kind"] == ReceiptKind.BASELINE.value
    assert bucket[0]["failing_tests"] == ["t1"]


@pytest.mark.asyncio
async def test_wiring_skips_if_already_baselined(monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    called = {"x": False}

    async def fake(**kwargs):
        called["x"] = True
        return ab.BaselineResult(captured=True)
    monkeypatch.setattr(sd, "synthesize_baseline", fake)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    # agent already dispatched a baseline this stage
    state.receipts[BASELINE_STASH_KEY] = [{"failing_tests": [], "total_tests": 0, "command": "x"}]
    await sd._maybe_run_auto_baseline(
        state=state, run_context={}, bearer=None,
        exec_policy=StageExecutionPolicy(stage_key="DEVELOP", auto_baseline=True),
        stage_policy=None,
    )
    assert called["x"] is False  # idempotent — no re-baseline


# ── S2.2 auto-verification receipt mapper ──────────────────────────────────────

def test_auto_verification_receipt_from_synth_ran_passed():
    r = sd._auto_verification_receipt_from_synth(
        {"kind": "ran", "tool_success": True, "command": "pytest", "exit_code": 0}
    )
    assert r["kind"] == ReceiptKind.AUTO_VERIFICATION.value
    assert r["status"] == "passed"
    assert r["tests_ran"] is True
    assert r["commands_run"] == ["pytest"]


def test_auto_verification_receipt_from_synth_ran_failed():
    r = sd._auto_verification_receipt_from_synth(
        {"kind": "ran", "tool_success": False, "command": "pytest", "exit_code": 1}
    )
    assert r["status"] == "failed"
    assert r["tests_ran"] is True


def test_auto_verification_receipt_from_synth_unavailable():
    r = sd._auto_verification_receipt_from_synth({"kind": "unavailable", "reason": "no verifier"})
    assert r["status"] == "unavailable"
    assert r["tests_ran"] is False
    assert "no verifier" in (r["summary"] or "")
