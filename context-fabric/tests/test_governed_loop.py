"""
M71 Slice C(a) — governed_step orchestrator unit tests.

Covers:
  * Tool calls in the allowlist dispatch + record outcomes.
  * Tool calls outside the allowlist refuse cleanly (no dispatch, captured outcome).
  * Mix of allowed + refused in one turn.
  * Phase output validation failure: no advance, validation_error populated.
  * Phase output validation success: advance + receipt persisted.
  * Illegal phase transition: refused with PHASE_TRANSITION_REFUSED.
  * Dispatch HTTP failure surfaces as ToolDispatchError outcome.

`dispatch_tool` and `emit_governed_event` are monkeypatched so tests don't
need mcp-server or audit-gov running.
"""
import pytest

from context_api_service.app.governed import (
    GovernedStepResult,
    Phase,
    PhasePolicy,
    PhaseState,
    StagePolicy,
    ToolDispatchError,
    ToolDispatchResult,
    governed_step,
)


def _policy(allowed_by_phase: dict[Phase, list[str]]) -> StagePolicy:
    """Build a minimal StagePolicy with the given per-phase allowlists."""
    phases: dict[Phase, PhasePolicy] = {}
    for phase, allowed in allowed_by_phase.items():
        phases[phase] = PhasePolicy(
            phase=phase,
            allowed_tools=frozenset(allowed),
            forbidden_tools=frozenset(),
            required_output_schema={},
            max_input_tokens=None,
            max_output_tokens=None,
            max_tool_calls=None,
        )
    return StagePolicy(
        policy_id="test-policy",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        version=1,
        status="ACTIVE",
        approval_model={},
        limits={"max_repair_attempts": 3},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={},
        phases=phases,
    )


def _fresh_state(phase: Phase = Phase.PLAN) -> PhaseState:
    """Mint a PhaseState at the given phase. PLAN by default; tests that
    need ACT/VERIFY/etc. walk the machine themselves so the test reads
    like a real call sequence."""
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    while state.current_phase is not phase:
        # Drive through the canonical happy path until we reach `phase`.
        # PLAN→EXPLORE→ACT→VERIFY→SELF_REVIEW→FINALIZE
        from context_api_service.app.governed.phase_state import advance_phase

        next_map = {
            Phase.PLAN: Phase.EXPLORE,
            Phase.EXPLORE: Phase.ACT,
            Phase.ACT: Phase.VERIFY,
            Phase.VERIFY: Phase.SELF_REVIEW,
            Phase.SELF_REVIEW: Phase.FINALIZE,
        }
        state = advance_phase(state, next_map[state.current_phase])
    return state


@pytest.fixture(autouse=True)
def _silence_audit(monkeypatch):
    """Replace emit_governed_event with a no-op so the orchestrator's audit
    calls don't try to reach audit-gov in unit tests."""
    async def _noop(**_kwargs):
        return None

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.emit_governed_event", _noop
    )


# ── allowed tool dispatch ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_allowed_tool_dispatches_and_records_result(monkeypatch):
    """Happy path: a tool in the phase's allowlist dispatches to mcp-server
    and the outcome lands on the result."""
    captured: dict = {}

    async def fake_dispatch(*, tool_name, args, **_kwargs):
        captured["tool_name"] = tool_name
        captured["args"] = args
        return ToolDispatchResult(
            result={"branches": ["main", "feature/x"]},
            duration_ms=42,
            tool_invocation_id="ti-001",
            tool_success=True,
            tool_error=None,
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )
    policy = _policy({Phase.PLAN: ["repo_map", "symbol_search"]})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[{"tool_name": "repo_map", "args": {"path": "."}}],
        policy=policy,
    )

    assert captured["tool_name"] == "repo_map"
    assert captured["args"] == {"path": "."}
    assert len(result.tool_outcomes) == 1
    outcome = result.tool_outcomes[0]
    assert outcome.allowed is True
    assert outcome.tool_success is True
    assert outcome.tool_invocation_id == "ti-001"
    assert outcome.result == {"branches": ["main", "feature/x"]}
    # M73-followup #4 — the args the LLM emitted must round-trip through
    # the outcome so stage_driver._history_from_turn can rebuild a faithful
    # assistant message on pause/resume.
    assert outcome.args == {"path": "."}
    assert result.phase_advanced is False  # no phase output, no advance


# ── refused tool ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_refused_tool_is_captured_and_not_dispatched(monkeypatch):
    """Tool not in the allowlist: no dispatch, refusal captured with allowlist."""
    dispatch_called = False

    async def fake_dispatch(*, tool_name, args, **_kwargs):
        nonlocal dispatch_called
        dispatch_called = True
        return ToolDispatchResult(
            result=None, duration_ms=0, tool_invocation_id="x", tool_success=True, tool_error=None
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )
    policy = _policy({Phase.PLAN: ["repo_map"]})  # apply_patch NOT allowed
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[{"tool_name": "apply_patch", "args": {"path": "a.py"}}],
        policy=policy,
    )

    assert dispatch_called is False
    assert len(result.tool_outcomes) == 1
    outcome = result.tool_outcomes[0]
    assert outcome.allowed is False
    assert outcome.tool_name == "apply_patch"
    assert outcome.refusal_reason is not None
    assert "not in the allowlist" in outcome.refusal_reason
    assert outcome.allowed_tools == ["repo_map"]


# ── mix of allowed + refused ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mix_of_allowed_and_refused_tools(monkeypatch):
    """One refused, one allowed — both outcomes captured in order."""
    async def fake_dispatch(*, tool_name, args, **_kwargs):
        return ToolDispatchResult(
            result={"ok": True, "tool": tool_name},
            duration_ms=10,
            tool_invocation_id=f"ti-{tool_name}",
            tool_success=True,
            tool_error=None,
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )
    policy = _policy({Phase.PLAN: ["repo_map"]})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[
            {"tool_name": "apply_patch", "args": {}},  # refused
            {"tool_name": "repo_map", "args": {}},     # allowed
        ],
        policy=policy,
    )

    assert len(result.tool_outcomes) == 2
    assert result.tool_outcomes[0].allowed is False
    assert result.tool_outcomes[0].tool_name == "apply_patch"
    assert result.tool_outcomes[1].allowed is True
    assert result.tool_outcomes[1].tool_name == "repo_map"


# ── dispatch error surfaces ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_error_lands_on_outcome(monkeypatch):
    """A ToolDispatchError (network/auth/5xx) becomes a tagged outcome,
    NOT an exception escaping governed_step."""
    async def fake_dispatch(*, tool_name, args, **_kwargs):
        raise ToolDispatchError("mcp-server unreachable: ConnectError")

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )
    policy = _policy({Phase.PLAN: ["repo_map"]})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[{"tool_name": "repo_map", "args": {}}],
        policy=policy,
    )

    outcome = result.tool_outcomes[0]
    assert outcome.allowed is True
    assert outcome.dispatch_error is not None
    assert "unreachable" in outcome.dispatch_error
    assert outcome.tool_invocation_id is None


# ── phase output validation + advance ──────────────────────────────────────


@pytest.mark.asyncio
async def test_phase_output_valid_advances_and_records_receipt():
    """A valid PLAN output with declared next_phase=EXPLORE advances the
    state machine and stamps the receipt."""
    policy = _policy({Phase.PLAN: [], Phase.EXPLORE: ["repo_map"]})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase_output={
            "target_files": ["src/a.py"],
            "test_strategy": {"commands": ["pytest tests/"]},
            "risk_level": "low",
        },
        next_phase=Phase.EXPLORE,
        policy=policy,
    )

    assert result.phase_advanced is True
    assert result.from_phase == "PLAN"
    assert result.to_phase == "EXPLORE"
    assert result.receipt is not None
    assert result.receipt["kind"] == "plan_receipt"
    assert result.next_state.current_phase is Phase.EXPLORE
    # Receipt is bucketed under the PHASE THAT PRODUCED IT.
    assert "PLAN" in result.next_state.receipts
    assert len(result.next_state.receipts["PLAN"]) == 1


@pytest.mark.asyncio
async def test_phase_output_invalid_does_not_advance():
    """Missing required field: validation_error populated, state unchanged."""
    policy = _policy({Phase.PLAN: []})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase_output={"target_files": ["a.py"]},  # missing test_strategy
        next_phase=Phase.EXPLORE,
        policy=policy,
    )

    assert result.phase_advanced is False
    assert result.next_state.current_phase is Phase.PLAN
    assert result.validation_error is not None
    assert result.validation_error["error_code"] == "PHASE_OUTPUT_INVALID"
    assert any(d["field"].startswith("test_strategy") for d in result.validation_error["details"])


@pytest.mark.asyncio
async def test_illegal_phase_transition_refused():
    """Skipping VERIFY (ACT → SELF_REVIEW) is forbidden by the table.
    advance_phase raises ValueError; we surface it as PHASE_TRANSITION_REFUSED."""
    policy = _policy({Phase.ACT: []})
    state = _fresh_state(Phase.ACT)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase_output={
            "edits": [{"file": "a.py", "edit_type": "apply_patch", "reason": "x"}]
        },
        next_phase=Phase.SELF_REVIEW,  # illegal — must go through VERIFY
        policy=policy,
    )

    assert result.phase_advanced is False
    assert result.validation_error is not None
    assert result.validation_error["error_code"] == "PHASE_TRANSITION_REFUSED"
    assert result.next_state.current_phase is Phase.ACT


# ── serialization shape ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_result_to_dict_serializable():
    """The result must JSON-serialize cleanly so FastAPI can return it."""
    import json

    policy = _policy({Phase.PLAN: []})
    state = _fresh_state(Phase.PLAN)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase_output={
            "target_files": ["a.py"],
            "test_strategy": {"commands": ["pytest"]},
            "risk_level": "low",
        },
        next_phase=Phase.EXPLORE,
        policy=policy,
    )

    payload = result.to_dict()
    serialized = json.dumps(payload)  # must not raise
    assert isinstance(serialized, str)
    assert payload["to_phase"] == "EXPLORE"
    assert payload["phase_advanced"] is True


# ── M83.x parallel exploration ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_parallel_safe_tools_dispatch_concurrently(monkeypatch):
    """When the LLM emits multiple tool_calls in the _PARALLEL_SAFE_TOOLS
    allowlist within a single turn, they dispatch concurrently rather than
    sequentially. We prove this by holding each dispatch behind an asyncio
    event and asserting wall-clock time is bounded by max(holds), not
    sum(holds)."""
    import asyncio
    import time

    # Each fake dispatch waits 100ms then returns. Three calls dispatched
    # sequentially would take ~300ms; concurrently they should be ~100ms.
    DISPATCH_HOLD = 0.1

    inflight = 0
    peak_inflight = 0
    inflight_lock = asyncio.Lock()

    async def fake_dispatch(*, tool_name, args, **_kwargs):
        nonlocal inflight, peak_inflight
        async with inflight_lock:
            inflight += 1
            peak_inflight = max(peak_inflight, inflight)
        try:
            await asyncio.sleep(DISPATCH_HOLD)
            return ToolDispatchResult(
                result={"tool": tool_name},
                duration_ms=int(DISPATCH_HOLD * 1000),
                tool_invocation_id=f"ti-{tool_name}",
                tool_success=True,
                tool_error=None,
            )
        finally:
            async with inflight_lock:
                inflight -= 1

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )

    policy = _policy({Phase.EXPLORE: ["repo_map", "list_files", "read_file"]})
    state = _fresh_state(Phase.EXPLORE)

    started = time.monotonic()
    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[
            {"tool_name": "repo_map", "args": {"path": "."}},
            {"tool_name": "list_files", "args": {"path": "src"}},
            {"tool_name": "read_file", "args": {"path": "README.md"}},
        ],
        policy=policy,
    )
    elapsed = time.monotonic() - started

    # All three outcomes are recorded, in submission order.
    assert len(result.tool_outcomes) == 3
    assert [o.tool_name for o in result.tool_outcomes] == [
        "repo_map", "list_files", "read_file",
    ]
    assert all(o.allowed and o.tool_success for o in result.tool_outcomes)
    # Parallelism evidence: peak in-flight must reach the number of
    # parallel-safe calls (or the configured concurrency cap, whichever
    # is smaller). Three reads under a cap of 6 means all three should
    # be in flight simultaneously.
    assert peak_inflight == 3, (
        f"expected 3 concurrent dispatches; got peak={peak_inflight}"
    )
    # Wall-clock check (loose to avoid flaky CI): three sequential 100ms
    # holds would take ~300ms. Concurrent should finish in ~100-180ms.
    # We assert <250ms which is a real signal without being timing-flaky.
    assert elapsed < 0.25, (
        f"parallel dispatch expected to finish in <250ms; took {elapsed*1000:.0f}ms"
    )


@pytest.mark.asyncio
async def test_mutation_tools_stay_sequential(monkeypatch):
    """A turn containing a mutating tool (apply_patch) — which is NOT in
    the parallel-safe allowlist — must dispatch sequentially. Verifies
    the partition logic: parallel-safe tools gather, the rest serialize."""
    import asyncio

    inflight = 0
    peak_inflight = 0
    inflight_lock = asyncio.Lock()

    async def fake_dispatch(*, tool_name, args, **_kwargs):
        nonlocal inflight, peak_inflight
        async with inflight_lock:
            inflight += 1
            peak_inflight = max(peak_inflight, inflight)
        try:
            await asyncio.sleep(0.05)
            return ToolDispatchResult(
                result={"tool": tool_name},
                duration_ms=50,
                tool_invocation_id=f"ti-{tool_name}",
                tool_success=True,
                tool_error=None,
            )
        finally:
            async with inflight_lock:
                inflight -= 1

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.dispatch_tool", fake_dispatch
    )

    policy = _policy({Phase.ACT: ["apply_patch", "write_file"]})
    state = _fresh_state(Phase.ACT)

    result = await governed_step(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        tool_calls=[
            {"tool_name": "apply_patch", "args": {"path": "a.py", "patch": "..."}},
            {"tool_name": "write_file", "args": {"path": "b.py", "content": "..."}},
        ],
        policy=policy,
    )

    assert len(result.tool_outcomes) == 2
    # No gather should have fired — mutations serialize.
    assert peak_inflight == 1, (
        f"mutating tools must dispatch sequentially; got peak={peak_inflight}"
    )
