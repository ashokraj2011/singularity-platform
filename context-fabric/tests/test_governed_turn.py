"""
M71 Slice C(b) — Single-turn driver unit tests.

Covers:
  * Extracting submit_phase_output from the LLM's tool calls correctly
    (single, multiple, invalid next_phase).
  * Tool descriptors include the synthetic submit_phase_output meta-tool
    on every phase.
  * Messages are composed with system + user from the resolved prompt.
  * run_turn dispatches policy + prompt loads + LLM call + governed_step
    in the right order, with monkey-patched upstream calls.
  * LLMGatewayError propagates without partial state mutation.
"""
import pytest

from context_api_service.app.governed import (
    ChatResponse,
    ChatToolCall,
    LLMGatewayError,
    Phase,
    PhasePolicy,
    PhaseState,
    StagePolicy,
)
from context_api_service.app.governed.turn import (
    SUBMIT_PHASE_OUTPUT,
    _build_messages,
    _build_tool_descriptors,
    _extract_phase_output,
    run_turn,
)
from context_api_service.app.governed.prompt_resolver import ResolvedPrompt


# ── helpers ─────────────────────────────────────────────────────────────────


def _policy(allowed: list[str], phase: Phase = Phase.PLAN) -> StagePolicy:
    pp = PhasePolicy(
        phase=phase,
        allowed_tools=frozenset(allowed),
        forbidden_tools=frozenset(),
        required_output_schema={},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=None,
    )
    return StagePolicy(
        policy_id="t",
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
        phases={phase: pp},
    )


def _multi_phase_policy(by_phase: dict[Phase, list[str]]) -> StagePolicy:
    """Build a multi-phase policy. Used by the M72 cache-stability tests
    to verify the descriptor union holds regardless of current phase."""
    phases: dict[Phase, PhasePolicy] = {}
    for phase, allowed in by_phase.items():
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
        policy_id="t-multi",
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


def _prompt(task: str = "Do the thing.") -> ResolvedPrompt:
    return ResolvedPrompt(
        task=task,
        system_prompt_append="You are a Developer Agent.",
        extra_context="",
        prompt_profile_id="profile-x",
        binding_id="binding-y",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase="PLAN",
    )


@pytest.fixture(autouse=True)
def _silence_audit(monkeypatch):
    """No audit-gov POSTs from unit tests."""
    async def _noop(**_kwargs):
        return None

    monkeypatch.setattr(
        "context_api_service.app.governed.loop.emit_governed_event", _noop
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.emit_governed_event", _noop
    )


# ── _extract_phase_output ───────────────────────────────────────────────────


def test_extract_phase_output_single_call():
    """One submit_phase_output → payload + next_phase + no leftover calls."""
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={
                "payload": {"target_files": ["a.py"]},
                "next_phase": "EXPLORE",
            },
        )
    ]
    payload, next_phase, others = _extract_phase_output(calls)
    assert payload == {"target_files": ["a.py"]}
    assert next_phase is Phase.EXPLORE
    assert others == []


def test_extract_phase_output_mixed_with_real_tools():
    """Tool calls + a submit at the end: only submit gets extracted."""
    calls = [
        ChatToolCall(id="c1", name="repo_map", arguments={"path": "."}),
        ChatToolCall(id="c2", name="symbol_search", arguments={"q": "evaluate"}),
        ChatToolCall(
            id="c3",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"x": 1}, "next_phase": "EXPLORE"},
        ),
    ]
    payload, next_phase, others = _extract_phase_output(calls)
    assert payload == {"x": 1}
    assert next_phase is Phase.EXPLORE
    assert [c.name for c in others] == ["repo_map", "symbol_search"]


def test_extract_phase_output_unknown_next_phase_dropped():
    """Bad next_phase string: payload still extracted, next_phase None."""
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"a": 1}, "next_phase": "gibberish"},
        )
    ]
    payload, next_phase, others = _extract_phase_output(calls)
    assert payload == {"a": 1}
    assert next_phase is None  # Unknown enum string is dropped, not raised.


def test_extract_phase_output_missing_payload():
    """If the LLM forgot the payload, we don't crash — payload stays None
    and the validator will fail downstream with a clear message."""
    calls = [
        ChatToolCall(id="c1", name=SUBMIT_PHASE_OUTPUT, arguments={"next_phase": "EXPLORE"})
    ]
    payload, next_phase, others = _extract_phase_output(calls)
    assert payload is None
    assert next_phase is Phase.EXPLORE


def test_extract_phase_output_last_call_wins():
    """Multiple submit_phase_output: the last one is the LLM's final say."""
    calls = [
        ChatToolCall(id="c1", name=SUBMIT_PHASE_OUTPUT, arguments={"payload": {"v": 1}}),
        ChatToolCall(id="c2", name=SUBMIT_PHASE_OUTPUT, arguments={"payload": {"v": 2}, "next_phase": "EXPLORE"}),
    ]
    payload, next_phase, others = _extract_phase_output(calls)
    assert payload == {"v": 2}
    assert next_phase is Phase.EXPLORE


# ── _build_tool_descriptors ─────────────────────────────────────────────────


def test_tool_descriptors_include_submit_phase_output():
    """submit_phase_output is the meta-tool the LLM uses to advance — it
    must appear on EVERY phase, even ones with no other tools."""
    policy = _policy(["repo_map"], phase=Phase.PLAN)
    tools = _build_tool_descriptors(policy, Phase.PLAN)
    names = [t["name"] for t in tools]
    assert "repo_map" in names
    assert SUBMIT_PHASE_OUTPUT in names


def test_tool_descriptors_for_empty_allowlist():
    """A phase with allowedTools=[] (e.g. PRODUCT_OWNER intake) still
    exposes submit_phase_output so the agent can advance."""
    policy = _policy([], phase=Phase.PLAN)
    tools = _build_tool_descriptors(policy, Phase.PLAN)
    assert [t["name"] for t in tools] == [SUBMIT_PHASE_OUTPUT]


# ── M72 Slice A — cache-stability invariant tests ──────────────────────────


def test_tool_descriptors_cache_stable_across_phases():
    """The CORE M72A invariant. The tool descriptor list must be IDENTICAL
    regardless of which phase the caller is currently in — otherwise the
    LLM provider's prompt cache prefix (which keys off tools[]) invalidates
    on every phase transition. The union-of-all-phases design keeps the
    tools block stable for the duration of a stage."""
    policy = _multi_phase_policy({
        Phase.PLAN:    ["repo_map", "symbol_search"],
        Phase.EXPLORE: ["read_file", "get_ast_slice", "symbol_search"],
        Phase.ACT:     ["apply_patch", "replace_text"],
        Phase.VERIFY:  ["run_test", "run_command"],
    })
    # Build descriptors as if we were in each phase.
    descriptors_by_phase = {
        phase: _build_tool_descriptors(policy, phase)
        for phase in (Phase.PLAN, Phase.EXPLORE, Phase.ACT, Phase.VERIFY)
    }
    # Same list of names, same order, in every phase. That's the cache key.
    names_per_phase = {
        phase: [t["name"] for t in desc]
        for phase, desc in descriptors_by_phase.items()
    }
    canonical = names_per_phase[Phase.PLAN]
    for phase, names in names_per_phase.items():
        assert names == canonical, f"Phase {phase} produced different tool list — cache will invalidate"

    # And the canonical list contains every tool from every phase, plus the
    # meta-tool, deduped + sorted.
    expected = sorted({
        "repo_map", "symbol_search", "read_file", "get_ast_slice",
        "apply_patch", "replace_text", "run_test", "run_command",
    }) + [SUBMIT_PHASE_OUTPUT]
    assert canonical == expected


def test_tool_descriptors_include_phase_scope_in_description():
    """Each tool's description must list the phases it's scoped to so the
    LLM can pick the right tool without us having to filter the list.
    `repo_map` is shared by PLAN+EXPLORE; `apply_patch` is ACT-only —
    descriptions must reflect both."""
    policy = _multi_phase_policy({
        Phase.PLAN:    ["repo_map"],
        Phase.EXPLORE: ["repo_map", "read_file"],
        Phase.ACT:     ["apply_patch"],
    })
    descs = {t["name"]: t["description"] for t in _build_tool_descriptors(policy, Phase.PLAN)}
    # repo_map shows BOTH phases.
    assert "PLAN" in descs["repo_map"]
    assert "EXPLORE" in descs["repo_map"]
    # apply_patch shows only ACT.
    assert "ACT" in descs["apply_patch"]
    assert "PLAN" not in descs["apply_patch"]
    # All phase-gated descriptions tell the LLM what happens on out-of-scope use.
    # The submit_phase_output meta-tool is the exception — it's always allowed
    # and doesn't carry the refusal warning.
    for name, desc in descs.items():
        if name == SUBMIT_PHASE_OUTPUT:
            continue
        assert "PHASE_TOOL_FORBIDDEN" in desc, f"{name!r} description missing refusal warning"


def test_tool_descriptors_respect_forbidden_tools():
    """forbidden_tools still wins over allowed_tools — deny takes priority
    per spec §8. write_file appears in both lists for one phase but the
    union must exclude it."""
    pp = PhasePolicy(
        phase=Phase.ACT,
        allowed_tools=frozenset(["apply_patch", "write_file"]),
        forbidden_tools=frozenset(["write_file"]),
        required_output_schema={},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=None,
    )
    policy = StagePolicy(
        policy_id="t-forbid",
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
        phases={Phase.ACT: pp},
    )
    names = [t["name"] for t in _build_tool_descriptors(policy, Phase.ACT)]
    assert "apply_patch" in names
    assert "write_file" not in names


def test_tool_descriptors_shape_is_provider_compatible():
    """Every descriptor must keep the strict three-field shape
    {name, description, input_schema} so Anthropic/OpenAI/Gemini accept
    it without schema-validation rejections. No phase_scope sibling field,
    no scope arrays at the top level."""
    policy = _multi_phase_policy({
        Phase.PLAN: ["repo_map"],
        Phase.ACT:  ["apply_patch"],
    })
    for desc in _build_tool_descriptors(policy, Phase.PLAN):
        assert set(desc.keys()) <= {"name", "description", "input_schema"}, \
            f"unexpected field on descriptor: {desc.keys()}"
        assert isinstance(desc["name"], str)
        assert isinstance(desc["description"], str)
        assert isinstance(desc["input_schema"], dict)


# ── _build_messages ─────────────────────────────────────────────────────────


def test_build_messages_system_plus_user():
    """First turn: system message from prompt, user message from task + extra."""
    prompt = ResolvedPrompt(
        task="Plan the change.",
        system_prompt_append="You are X.",
        extra_context="Extra: do Y.",
        prompt_profile_id="p",
        binding_id="b",
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        phase="PLAN",
    )
    messages = _build_messages(prompt, [])
    assert messages[0] == {"role": "system", "content": "You are X."}
    assert messages[1]["role"] == "user"
    assert "Plan the change." in messages[1]["content"]
    assert "do Y." in messages[1]["content"]


def test_build_messages_appends_history():
    """History items pass through verbatim after the system + user pair."""
    prompt = _prompt()
    history = [
        {"role": "assistant", "content": "I'll use repo_map.", "tool_calls": [{"id": "c1", "name": "repo_map"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "src/a.py\nsrc/b.py"},
    ]
    messages = _build_messages(prompt, history)
    assert messages[-2:] == history


# ── run_turn — happy path with mocks ────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_turn_happy_path_phase_advance(monkeypatch):
    """End-to-end with all three upstreams mocked: policy → prompt → LLM
    → governed_step → result. LLM returns a submit_phase_output that
    advances PLAN → EXPLORE."""
    captured: dict = {}

    async def fake_load_stage_policy(stage_key, agent_role, *, bearer=None):
        captured["loaded_policy"] = (stage_key, agent_role)
        return _policy([], phase=Phase.PLAN)

    async def fake_resolve_prompt(*, stage_key, agent_role, phase, vars=None, bearer=None):
        captured["resolved_prompt"] = (stage_key, agent_role, phase.value if phase else None)
        return _prompt()

    async def fake_call_gateway(*, messages, tools, model_alias=None, temperature=None,
                                max_output_tokens=None, bearer=None):
        captured["messages"] = messages
        captured["tool_count"] = len(tools)
        # Simulate the LLM emitting submit_phase_output with a valid PLAN receipt.
        return ChatResponse(
            content="Planning done.",
            tool_calls=[ChatToolCall(
                id="t1",
                name=SUBMIT_PHASE_OUTPUT,
                arguments={
                    "payload": {
                        "target_files": ["src/eval.py"],
                        "test_strategy": {"commands": ["pytest tests/"]},
                        "risk_level": "low",
                    },
                    "next_phase": "EXPLORE",
                },
            )],
            finish_reason="tool_calls",
            input_tokens=120,
            output_tokens=45,
            latency_ms=210,
            provider="mock",
            model="mock-fast",
            model_alias="mock-fast",
            estimated_cost=0.0,
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.turn.load_stage_policy", fake_load_stage_policy
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.resolve_phase_prompt", fake_resolve_prompt
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.call_gateway_chat", fake_call_gateway
    )

    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    turn = await run_turn(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        vars={"goal": "Fix the NPE"},
    )

    assert captured["loaded_policy"] == ("loop.stage", "DEVELOPER")
    assert captured["resolved_prompt"] == ("loop.stage", "DEVELOPER", "PLAN")
    assert captured["tool_count"] >= 1  # at least submit_phase_output
    assert turn.next_state.current_phase is Phase.EXPLORE
    assert turn.step.phase_advanced is True
    assert turn.llm["finish_reason"] == "tool_calls"
    assert turn.prompt["binding_id"] == "binding-y"
    assert turn.policy["max_repair_attempts"] == 3


@pytest.mark.asyncio
async def test_run_turn_llm_error_propagates(monkeypatch):
    """LLMGatewayError surfaces to the caller — state is NOT mutated."""
    async def fake_load_stage_policy(stage_key, agent_role, *, bearer=None):
        return _policy([], phase=Phase.PLAN)

    async def fake_resolve_prompt(**_kwargs):
        return _prompt()

    async def fake_call_gateway(**_kwargs):
        raise LLMGatewayError("LLM_GATEWAY_TIMEOUT", "fake timeout")

    monkeypatch.setattr(
        "context_api_service.app.governed.turn.load_stage_policy", fake_load_stage_policy
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.resolve_phase_prompt", fake_resolve_prompt
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.call_gateway_chat", fake_call_gateway
    )

    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    with pytest.raises(LLMGatewayError) as exc_info:
        await run_turn(
            state=state, stage_key="loop.stage", agent_role="DEVELOPER",
        )
    assert exc_info.value.error_code == "LLM_GATEWAY_TIMEOUT"


@pytest.mark.asyncio
async def test_run_turn_validation_error_does_not_advance(monkeypatch):
    """LLM submits a malformed PLAN receipt (missing test_strategy). The
    validator catches it; phase does NOT advance; validation_error populates."""
    async def fake_load_stage_policy(stage_key, agent_role, *, bearer=None):
        return _policy([], phase=Phase.PLAN)

    async def fake_resolve_prompt(**_kwargs):
        return _prompt()

    async def fake_call_gateway(**_kwargs):
        return ChatResponse(
            content="oops",
            tool_calls=[ChatToolCall(
                id="t1",
                name=SUBMIT_PHASE_OUTPUT,
                arguments={"payload": {"target_files": ["a.py"]}, "next_phase": "EXPLORE"},
            )],
            finish_reason="tool_calls",
            input_tokens=10, output_tokens=5, latency_ms=1,
            provider="mock", model="mock-fast",
        )

    monkeypatch.setattr(
        "context_api_service.app.governed.turn.load_stage_policy", fake_load_stage_policy
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.resolve_phase_prompt", fake_resolve_prompt
    )
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.call_gateway_chat", fake_call_gateway
    )

    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    turn = await run_turn(
        state=state, stage_key="loop.stage", agent_role="DEVELOPER",
    )
    assert turn.next_state.current_phase is Phase.PLAN  # unchanged
    assert turn.step.phase_advanced is False
    assert turn.step.validation_error is not None
    assert turn.step.validation_error["error_code"] == "PHASE_OUTPUT_INVALID"
