"""M99 S1.3 — git push preflight synthesis + run_stage shadow wiring."""
import pytest

from context_api_service.app.governed import git_preflight as gp
from context_api_service.app.governed import stage_driver as sd
from context_api_service.app.governed.dispatch import ToolDispatchError
from context_api_service.app.governed.phase_state import Phase, PhaseState
from context_api_service.app.governed.receipts import GitPreflightReceipt, ReceiptKind
from context_api_service.app.governed.stage_execution_policy import StageExecutionPolicy

_ENV = "CF_GIT_PREFLIGHT_ENABLED"
_KEY = "__git_preflight__"


class _FakeOutcome:
    def __init__(self, result, tool_success=True, tool_error=None):
        self.result = result
        self.tool_success = tool_success
        self.tool_error = tool_error
        self.duration_ms = 1
        self.tool_invocation_id = "inv"


def _patch_dispatch(monkeypatch, response):
    async def fake_dispatch(tool_name, args, **kwargs):
        if isinstance(response, Exception):
            raise response
        return response
    monkeypatch.setattr(gp, "dispatch_tool", fake_dispatch)


@pytest.mark.asyncio
async def test_preflight_ok(monkeypatch):
    _patch_dispatch(monkeypatch, _FakeOutcome({"ok": True, "remote": "origin", "branch": "wi/x", "has_commit": True}))
    res = await gp.synthesize_git_preflight(
        branch="wi/x", remote="origin", work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.ok is True
    assert res.blocked_code is None
    GitPreflightReceipt(**res.to_receipt_payload())  # round-trips


@pytest.mark.asyncio
async def test_preflight_blocked_maps_code_and_fix(monkeypatch):
    _patch_dispatch(monkeypatch, _FakeOutcome({
        "ok": False, "remote": "origin", "branch": "main",
        "blocked_code": "GIT_BRANCH_PROTECTED",
        "fix_commands": ["open a PR"], "retryable": False, "has_commit": True,
    }))
    res = await gp.synthesize_git_preflight(
        branch="main", remote="origin", work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.ok is False
    assert res.blocked_code == "GIT_BRANCH_PROTECTED"
    assert res.fix_commands == ["open a PR"]
    assert res.retryable is False


@pytest.mark.asyncio
async def test_preflight_dispatch_error_is_swallowed(monkeypatch):
    _patch_dispatch(monkeypatch, ToolDispatchError("boom"))
    res = await gp.synthesize_git_preflight(
        branch="x", remote=None, work_item_id=None, workspace_id="ws",
        run_context=None, bearer=None,
    )
    assert res.ok is False
    assert res.reason is not None
    assert res.blocked_code is None  # couldn't classify; not a false positive


@pytest.mark.asyncio
async def test_preflight_tool_failure_is_swallowed(monkeypatch):
    _patch_dispatch(monkeypatch, _FakeOutcome(None, tool_success=False, tool_error="x"))
    res = await gp.synthesize_git_preflight(
        branch="x", remote=None, work_item_id="wi", workspace_id=None,
        run_context={}, bearer=None,
    )
    assert res.ok is False
    assert res.reason is not None


# ── run_stage shadow wiring ────────────────────────────────────────────────────

async def _noop_emit(**kwargs):
    return None


def _state():
    return PhaseState(stage_key="DEVELOP", agent_role="DEVELOPER", current_phase=Phase.EXPLORE)


@pytest.mark.asyncio
async def test_wiring_noop_when_env_disabled(monkeypatch):
    monkeypatch.delenv(_ENV, raising=False)
    called = {"x": False}

    async def fake(**kwargs):
        called["x"] = True
        return gp.GitPreflightResult(ok=True)
    monkeypatch.setattr(sd, "synthesize_git_preflight", fake)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    await sd._maybe_run_git_preflight(
        state=state, vars={}, run_context={}, bearer=None,
        exec_policy=StageExecutionPolicy(stage_key="DEVELOP", git_preflight_required=True),
        stage_policy=None,
    )
    assert called["x"] is False
    assert _KEY not in state.receipts


@pytest.mark.asyncio
async def test_wiring_stashes_receipt_when_enabled(monkeypatch):
    monkeypatch.setenv(_ENV, "1")

    async def fake(**kwargs):
        return gp.GitPreflightResult(ok=False, branch="main", blocked_code="GIT_BRANCH_PROTECTED",
                                     fix_commands=["open a PR"])
    monkeypatch.setattr(sd, "synthesize_git_preflight", fake)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    v = {}
    await sd._maybe_run_git_preflight(
        state=state, vars=v, run_context={"branchName": "main"}, bearer=None,
        exec_policy=StageExecutionPolicy(stage_key="DEVELOP", git_preflight_required=True),
        stage_policy=None,
    )
    bucket = state.receipts[_KEY]
    assert len(bucket) == 1
    assert bucket[0]["kind"] == ReceiptKind.GIT_PREFLIGHT.value
    assert bucket[0]["blocked_code"] == "GIT_BRANCH_PROTECTED"
    # blocked → injected into vars for visibility
    assert v["git_preflight_receipt"]["blocked_code"] == "GIT_BRANCH_PROTECTED"
