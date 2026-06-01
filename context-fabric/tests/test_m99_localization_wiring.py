"""M99 S1.1 — run_stage localization wiring (the _maybe_run_localization helper)."""
import pytest

from context_api_service.app.governed import stage_driver as sd
from context_api_service.app.governed.localization import LocalizationResult
from context_api_service.app.governed.phase_state import Phase, PhaseState

_ENV = "CF_AGENTIC_CODING_V2_ENABLED"
_KEY = "__localization__"


def _state():
    return PhaseState(stage_key="DEVELOP", agent_role="DEVELOPER", current_phase=Phase.EXPLORE)


async def _noop_emit(**kwargs):
    return None


def _policy(**kw):
    from context_api_service.app.governed.stage_execution_policy import StageExecutionPolicy
    return StageExecutionPolicy(stage_key="DEVELOP", **kw)


def _patch(monkeypatch, *, sweep_result=None, sweep_exc=None):
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    async def fake_sweep(**kwargs):
        if sweep_exc is not None:
            raise sweep_exc
        return sweep_result
    monkeypatch.setattr(sd, "synthesize_localization", fake_sweep)


@pytest.mark.asyncio
async def test_noop_when_env_disabled(monkeypatch):
    monkeypatch.delenv(_ENV, raising=False)
    called = {"sweep": False}

    async def fake_sweep(**kwargs):
        called["sweep"] = True
        return LocalizationResult()
    monkeypatch.setattr(sd, "synthesize_localization", fake_sweep)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    await sd._maybe_run_localization(
        state=state, vars={"goal": "x"}, run_context={}, bearer=None,
        exec_policy=_policy(auto_localize=True), stage_policy=None,  # policy on, env off
    )
    assert called["sweep"] is False
    assert _KEY not in state.receipts


@pytest.mark.asyncio
async def test_runs_and_stashes_receipt_when_enabled(monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    res = LocalizationResult(
        target_files=["src/ops.py"], target_symbols=["startsWith"],
        target_tests=["tests/test_ops.py"], sources=["find_symbol"],
        summary="localized 1 file",
    )
    _patch(monkeypatch, sweep_result=res)
    state = _state()
    v = {"goal": "add startsWith"}
    await sd._maybe_run_localization(
        state=state, vars=v, run_context={"capabilityId": "c1", "workItemId": "wi"},
        bearer=None, exec_policy=_policy(auto_localize=True), stage_policy=None,
    )
    # persisted under sentinel as a single-element list
    bucket = state.receipts[_KEY]
    assert isinstance(bucket, list) and len(bucket) == 1
    assert bucket[0]["target_files"] == ["src/ops.py"]
    assert bucket[0]["kind"] == "localization_receipt"
    # injected into vars for prompt rendering
    assert v["localization_receipt"]["target_symbols"] == ["startsWith"]
    assert v["localization_summary"] == "localized 1 file"


@pytest.mark.asyncio
async def test_sentinel_skipped_by_phase_bucket_readers(monkeypatch):
    """The sentinel key must not look like a Phase.value, so receipt readers
    that iterate phase buckets skip it."""
    monkeypatch.setenv(_ENV, "1")
    _patch(monkeypatch, sweep_result=LocalizationResult(target_files=["a.py"]))
    state = _state()
    await sd._maybe_run_localization(
        state=state, vars={"goal": "x"}, run_context={}, bearer=None,
        exec_policy=_policy(auto_localize=True), stage_policy=None,
    )
    assert _KEY.startswith("__") and _KEY.endswith("__")
    assert _KEY not in {p.value for p in Phase}


@pytest.mark.asyncio
async def test_empty_result_stashes_but_not_into_vars(monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    _patch(monkeypatch, sweep_result=LocalizationResult(reason="nothing found"))
    state = _state()
    v = {"goal": "x"}
    await sd._maybe_run_localization(
        state=state, vars=v, run_context={}, bearer=None,
        exec_policy=_policy(auto_localize=True), stage_policy=None,
    )
    assert _KEY in state.receipts  # persisted for audit
    assert "localization_receipt" not in v  # no empty target list into prompt


@pytest.mark.asyncio
async def test_sweep_exception_is_swallowed(monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    _patch(monkeypatch, sweep_exc=RuntimeError("boom"))
    state = _state()
    await sd._maybe_run_localization(  # must not raise
        state=state, vars={"goal": "x"}, run_context={}, bearer=None,
        exec_policy=_policy(auto_localize=True), stage_policy=None,
    )
    assert _KEY not in state.receipts


@pytest.mark.asyncio
async def test_policy_flag_off_is_noop_even_with_env(monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    called = {"sweep": False}

    async def fake_sweep(**kwargs):
        called["sweep"] = True
        return LocalizationResult()
    monkeypatch.setattr(sd, "synthesize_localization", fake_sweep)
    monkeypatch.setattr(sd, "emit_governed_event", _noop_emit)

    state = _state()
    await sd._maybe_run_localization(
        state=state, vars={"goal": "x"}, run_context={}, bearer=None,
        exec_policy=_policy(), stage_policy=None,  # auto_localize defaults None
    )
    assert called["sweep"] is False
