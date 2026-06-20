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


def _policy(
    allowed: list[str],
    phase: Phase = Phase.PLAN,
    context_policy: dict | None = None,
) -> StagePolicy:
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
        context_policy=context_policy or {},
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
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"target_files": ["a.py"]}
    assert next_phase is Phase.EXPLORE
    assert others == []
    assert malformed is None


def test_extract_phase_output_mixed_with_real_tools():
    """Tool calls + a submit at the end: only submit gets extracted."""
    calls = [
        ChatToolCall(id="c1", name="repo_map", arguments={"path": "."}),
        ChatToolCall(id="c2", name="find_symbol", arguments={"q": "evaluate"}),
        ChatToolCall(
            id="c3",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"x": 1}, "next_phase": "EXPLORE"},
        ),
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"x": 1}
    assert next_phase is Phase.EXPLORE
    assert [c.name for c in others] == ["repo_map", "find_symbol"]
    assert malformed is None


def test_extract_phase_output_unknown_next_phase_dropped():
    """Bad next_phase string: payload still extracted, next_phase None."""
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"a": 1}, "next_phase": "gibberish"},
        )
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"a": 1}
    assert next_phase is None  # Unknown enum string is dropped, not raised.
    assert malformed is None


def test_extract_phase_output_missing_payload_reports_malformed():
    """If the LLM forgot `payload` entirely AND didn't put any other keys
    (besides next_phase) at the top of arguments, the call is malformed —
    surface it so the next turn gets corrective feedback. Without this
    the silent-drop hits the stagnant-turn guard after 3 retries.
    """
    calls = [
        ChatToolCall(id="c1", name=SUBMIT_PHASE_OUTPUT, arguments={"next_phase": "EXPLORE"})
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload is None
    # next_phase was valid in isolation, but we don't advance without a
    # payload — the caller treats malformed-not-None as the stop signal.
    assert next_phase is None
    assert malformed is not None
    assert "missing required field `payload`" in malformed.reason
    assert malformed.payload_type == "missing"
    assert malformed.next_phase_raw == "EXPLORE"


def test_extract_phase_output_stringified_payload_decoded():
    """Some providers stringify the inner `payload` even when the outer
    arguments object is already an object. JSON-decode the inner string
    rather than silently dropping it.
    """
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={
                "payload": '{"story_brief": "X", "acceptance_criteria": ["a"]}',
                "next_phase": "SELF_REVIEW",
            },
        )
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"story_brief": "X", "acceptance_criteria": ["a"]}
    assert next_phase is Phase.SELF_REVIEW
    assert malformed is None


def test_extract_phase_output_unparseable_string_payload_reports_malformed():
    """A non-JSON string in `payload` is not silently dropped — operators
    need to see the bad shape in audit-gov so they can fix the prompt or
    swap the model.
    """
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": "this is not JSON {{", "next_phase": "EXPLORE"},
        )
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload is None
    assert malformed is not None
    assert "JSON-decode" in malformed.reason
    assert malformed.payload_type == "str"


def test_extract_phase_output_collapsed_wrapper_accepted():
    """Smaller models routinely collapse the {payload: {...}} wrapper and
    put receipt fields at the top level of arguments. Accept that shape —
    it's the LLM's intent and the validator can sort out the rest.
    """
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={
                "story_brief": "Implement X",
                "acceptance_criteria": ["a", "b"],
                "next_phase": "SELF_REVIEW",
            },
        )
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"story_brief": "Implement X", "acceptance_criteria": ["a", "b"]}
    # next_phase is stripped from the collapsed payload but still resolved.
    assert "next_phase" not in payload
    assert next_phase is Phase.SELF_REVIEW
    assert malformed is None


def test_extract_phase_output_last_call_wins():
    """Multiple submit_phase_output: the last one is the LLM's final say."""
    calls = [
        ChatToolCall(id="c1", name=SUBMIT_PHASE_OUTPUT, arguments={"payload": {"v": 1}}),
        ChatToolCall(id="c2", name=SUBMIT_PHASE_OUTPUT, arguments={"payload": {"v": 2}, "next_phase": "EXPLORE"}),
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"v": 2}
    assert next_phase is Phase.EXPLORE
    assert malformed is None


def test_extract_phase_output_last_good_wins_over_earlier_malformed():
    """If the LLM mis-shapes the first attempt and corrects on the second,
    we take the second. The malformed report is cleared (the LLM already
    self-corrected within the same turn)."""
    calls = [
        ChatToolCall(id="c1", name=SUBMIT_PHASE_OUTPUT, arguments={"next_phase": "EXPLORE"}),
        ChatToolCall(
            id="c2",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"v": 2}, "next_phase": "EXPLORE"},
        ),
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"v": 2}
    assert next_phase is Phase.EXPLORE
    assert malformed is None


def test_extract_phase_output_malformed_after_good_keeps_good():
    """A malformed second call does NOT clobber a valid first call's
    payload — we'd rather validate the good one than throw it away just
    because the LLM produced a second confused tool call in the same turn.

    The malformed flag is still set so audit-gov shows the operator the
    model emitted a sketchy retry, but run_turn's malformed-handling
    branch only fires when phase_output is also None, so this case
    proceeds normally to receipt validation with the good payload.
    """
    calls = [
        ChatToolCall(
            id="c1",
            name=SUBMIT_PHASE_OUTPUT,
            arguments={"payload": {"v": 1}, "next_phase": "EXPLORE"},
        ),
        ChatToolCall(id="c2", name=SUBMIT_PHASE_OUTPUT, arguments={"next_phase": "EXPLORE"}),
    ]
    payload, next_phase, others, malformed = _extract_phase_output(calls)
    assert payload == {"v": 1}
    assert next_phase is Phase.EXPLORE
    # The malformed report is set (the second call WAS malformed) but
    # run_turn's gate `phase_output is None and not other_calls` is
    # False here, so the malformed branch will not fire — the operator
    # just gets the audit signal that the model's second emission was
    # confused.
    assert malformed is not None


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
        Phase.PLAN:    ["repo_map", "find_symbol"],
        Phase.EXPLORE: ["read_file", "get_ast_slice", "find_symbol"],
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
        "repo_map", "find_symbol", "read_file", "get_ast_slice",
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


def test_tool_descriptors_respect_effective_agent_profile_capabilities():
    policy = _multi_phase_policy({
        Phase.PLAN: ["repo_map", "read_file"],
        Phase.ACT: ["apply_patch"],
    })

    names = [
        tool["name"]
        for tool in _build_tool_descriptors(
            policy,
            Phase.PLAN,
            effective_capabilities=[
                {"id": "repo_map", "permissions": ["read", "invoke"]},
                {"id": "read_file", "permissions": ["read"]},
            ],
        )
    ]

    assert names == ["repo_map", SUBMIT_PHASE_OUTPUT]


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
    """History items pass through after the system + user pair. Non-tool
    messages are verbatim; tool messages are wrapped in <tool_result>
    delimiters by M74 Phase 3B's safen_history."""
    prompt = _prompt()
    history = [
        {"role": "assistant", "content": "I'll use repo_map.", "tool_calls": [{"id": "c1", "name": "repo_map"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "src/a.py\nsrc/b.py"},
    ]
    messages = _build_messages(prompt, history)
    # Assistant message passes through verbatim
    assert messages[-2] == history[0]
    # Tool message is wrapped but otherwise structurally identical
    wrapped_tool = messages[-1]
    assert wrapped_tool["role"] == "tool"
    assert wrapped_tool["tool_call_id"] == "c1"
    assert wrapped_tool["content"].startswith("<tool_result>")
    assert wrapped_tool["content"].endswith("</tool_result>")
    assert "src/a.py\nsrc/b.py" in wrapped_tool["content"]


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

    async def fake_resolve_prompt(*, stage_key, agent_role, phase, vars=None, bearer=None, **_kwargs):
        captured["resolved_prompt"] = (stage_key, agent_role, phase.value if phase else None)
        return _prompt()

    async def fake_call_gateway(*, messages, tools, model_alias=None, temperature=None,
                                max_output_tokens=None, bearer=None, **_kwargs):
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
async def test_run_turn_per_phase_model_override(monkeypatch):
    """M100 — phase_model_aliases routes the CURRENT phase to its pinned
    model alias; an unset phase falls back to the stage-level model_alias."""
    captured: dict = {}

    async def fake_load_stage_policy(stage_key, agent_role, *, bearer=None):
        return _policy([], phase=Phase.PLAN)

    async def fake_resolve_prompt(*, stage_key, agent_role, phase, vars=None, bearer=None, **_kwargs):
        return _prompt()

    async def fake_call_gateway(*, messages, tools, model_alias=None, **_kwargs):
        captured["model_alias"] = model_alias
        return ChatResponse(
            content="ok.",
            tool_calls=[],
            finish_reason="stop",
            input_tokens=10,
            output_tokens=5,
            latency_ms=10,
            provider="mock",
            model="mock-fast",
            model_alias=model_alias,
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

    # Fresh state starts in PLAN. A PLAN-specific alias wins over the stage default.
    state = PhaseState.fresh("loop.stage", "DEVELOPER")
    assert state.current_phase is Phase.PLAN
    await run_turn(
        state=state,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        model_alias="stage-default",
        phase_model_aliases={"PLAN": "plan-model", "ACT": "act-model"},
    )
    assert captured["model_alias"] == "plan-model"

    # No PLAN entry → falls back to the stage-level model_alias.
    captured.clear()
    state2 = PhaseState.fresh("loop.stage", "DEVELOPER")
    await run_turn(
        state=state2,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        model_alias="stage-default",
        phase_model_aliases={"ACT": "act-model"},
    )
    assert captured["model_alias"] == "stage-default"

    # No per-phase map at all → stage default (legacy behavior).
    captured.clear()
    state3 = PhaseState.fresh("loop.stage", "DEVELOPER")
    await run_turn(
        state=state3,
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        model_alias="stage-default",
    )
    assert captured["model_alias"] == "stage-default"


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


# ── M98 P3: per-attempt code_context_package cache ──────────────────────────


def _advancing_response() -> ChatResponse:
    """A submit_phase_output the PLAN validator accepts (PLAN → EXPLORE)."""
    return ChatResponse(
        content="planning done",
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
        input_tokens=10, output_tokens=5, latency_ms=1,
        provider="mock", model="mock-fast",
    )


def _patch_context_turn(monkeypatch, *, build_fn, seen_vars):
    """Wire the four upstreams run_turn() touches when the policy opts into
    include_code_context_package. build_fn is the (counting) stand-in for
    the mcp-server AST round trip; seen_vars captures the prompt vars each
    turn so the test can assert the package markdown was injected."""
    async def fake_load_stage_policy(stage_key, agent_role, *, bearer=None):
        return _policy([], phase=Phase.PLAN,
                       context_policy={"include_code_context_package": True})

    async def fake_resolve_prompt(*, vars=None, **_kwargs):
        seen_vars.append(dict(vars or {}))
        return _prompt()

    async def fake_call_gateway(**_kwargs):
        return _advancing_response()

    monkeypatch.setattr(
        "context_api_service.app.governed.turn.load_stage_policy", fake_load_stage_policy)
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.resolve_phase_prompt", fake_resolve_prompt)
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.call_gateway_chat", fake_call_gateway)
    monkeypatch.setattr(
        "context_api_service.app.governed.turn.build_code_context_for_governed_turn", build_fn)


@pytest.mark.asyncio
async def test_code_context_built_once_and_reused_across_turns(monkeypatch):
    """The AST-built code_context_package is fetched once per attempt and
    reused on later turns. run_stage() shares one code_context_cache dict
    across all its run_turn() calls, so the second turn must hit the cache
    instead of re-POSTing to mcp-server's /mcp/code-context/build."""
    build_calls: list[str] = []
    seen_vars: list[dict] = []

    async def fake_build(*, task_text, capability_id, run_context, **_kwargs):
        build_calls.append(task_text)
        return {"context_package_id": "ctx-1", "packageMarkdown": "# relevant code"}, None

    _patch_context_turn(monkeypatch, build_fn=fake_build, seen_vars=seen_vars)

    cache: dict = {}
    for _ in range(2):
        await run_turn(
            state=PhaseState.fresh("loop.stage", "DEVELOPER"),
            stage_key="loop.stage",
            agent_role="DEVELOPER",
            vars={"goal": "Fix the NPE"},
            run_context={"capability_id": "cap-1"},
            code_context_cache=cache,
        )

    # Built exactly once despite two turns.
    assert build_calls == ["Fix the NPE"]
    # Both turns still received the package markdown in their prompt vars.
    assert len(seen_vars) == 2
    assert all(v.get("code_context_package") == "# relevant code" for v in seen_vars)
    assert all(v.get("code_context_package_id") == "ctx-1" for v in seen_vars)


@pytest.mark.asyncio
async def test_code_context_rebuilds_every_turn_without_cache(monkeypatch):
    """Backwards-compat contract: when no cache dict is threaded (the
    default — execute.py's legacy single-turn path + older callers), the
    package is rebuilt every turn exactly as it was pre-M98."""
    build_calls: list[str] = []
    seen_vars: list[dict] = []

    async def fake_build(*, task_text, capability_id, run_context, **_kwargs):
        build_calls.append(task_text)
        return {"context_package_id": "ctx-1", "packageMarkdown": "# relevant code"}, None

    _patch_context_turn(monkeypatch, build_fn=fake_build, seen_vars=seen_vars)

    for _ in range(2):
        await run_turn(
            state=PhaseState.fresh("loop.stage", "DEVELOPER"),
            stage_key="loop.stage",
            agent_role="DEVELOPER",
            vars={"goal": "Fix the NPE"},
            run_context={"capability_id": "cap-1"},
            # code_context_cache omitted → None → no caching.
        )

    assert build_calls == ["Fix the NPE", "Fix the NPE"]  # rebuilt each turn


@pytest.mark.asyncio
async def test_code_context_cache_disabled_by_env(monkeypatch):
    """GOVERNED_CODE_CONTEXT_CACHE=0 forces the old rebuild-every-turn
    behavior even when a cache dict is present (debug/rollback escape hatch)."""
    monkeypatch.setenv("GOVERNED_CODE_CONTEXT_CACHE", "0")
    build_calls: list[str] = []
    seen_vars: list[dict] = []

    async def fake_build(*, task_text, capability_id, run_context, **_kwargs):
        build_calls.append(task_text)
        return {"context_package_id": "ctx-1", "packageMarkdown": "# relevant code"}, None

    _patch_context_turn(monkeypatch, build_fn=fake_build, seen_vars=seen_vars)

    cache: dict = {}
    for _ in range(2):
        await run_turn(
            state=PhaseState.fresh("loop.stage", "DEVELOPER"),
            stage_key="loop.stage",
            agent_role="DEVELOPER",
            vars={"goal": "Fix the NPE"},
            run_context={"capability_id": "cap-1"},
            code_context_cache=cache,
        )

    assert build_calls == ["Fix the NPE", "Fix the NPE"]  # env opt-out wins
    assert cache == {}  # nothing cached when disabled


# ── Min-context gate + budget (code-context hardening D1/D3) ──────────────────


def _code_edit_exec_policy():
    from context_api_service.app.governed.stage_execution_policy import StageExecutionPolicy
    return StageExecutionPolicy(stage_key="loop.stage", context_policy="CODE_EDIT")


@pytest.mark.asyncio
async def test_min_context_gate_pauses_code_edit_stage(monkeypatch):
    """A CODE_EDIT stage whose code-context package has no target/editable
    slices raises MinContextUnavailable (→ stage_driver NEEDS_CONTEXT pause)."""
    from context_api_service.app.governed.turn import MinContextUnavailable
    seen_vars: list[dict] = []

    async def empty_build(*, task_text, capability_id, run_context, **_kwargs):
        return ({"context_package_id": "ctx-empty", "packageMarkdown": "",
                 "target_symbols": [], "editable_slices": []}, "no slices")

    _patch_context_turn(monkeypatch, build_fn=empty_build, seen_vars=seen_vars)

    with pytest.raises(MinContextUnavailable):
        await run_turn(
            state=PhaseState.fresh("loop.stage", "DEVELOPER"),
            stage_key="loop.stage",
            agent_role="DEVELOPER",
            vars={"goal": "Fix the NPE"},
            run_context={"capability_id": "cap-1"},
            exec_policy=_code_edit_exec_policy(),
        )


@pytest.mark.asyncio
async def test_min_context_gate_allows_when_slices_present(monkeypatch):
    """CODE_EDIT stage WITH editable slices proceeds — no pause."""
    seen_vars: list[dict] = []

    async def good_build(*, task_text, capability_id, run_context, **_kwargs):
        return ({"context_package_id": "ctx-ok", "packageMarkdown": "# code",
                 "target_symbols": [{"symbol": "foo"}],
                 "editable_slices": [{"file": "a.py"}]}, None)

    _patch_context_turn(monkeypatch, build_fn=good_build, seen_vars=seen_vars)

    await run_turn(
        state=PhaseState.fresh("loop.stage", "DEVELOPER"),
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        vars={"goal": "Fix the NPE"},
        run_context={"capability_id": "cap-1"},
        exec_policy=_code_edit_exec_policy(),
    )
    assert seen_vars and seen_vars[0].get("code_context_package") == "# code"


@pytest.mark.asyncio
async def test_min_context_gate_skips_non_code_edit_stage(monkeypatch):
    """A non-CODE_EDIT stage with empty slices does NOT pause — the gate only
    fires for code-edit stages, so read/verify stages degrade as before."""
    seen_vars: list[dict] = []

    async def empty_build(*, task_text, capability_id, run_context, **_kwargs):
        return ({"context_package_id": "ctx-empty", "packageMarkdown": "",
                 "target_symbols": [], "editable_slices": []}, "no slices")

    _patch_context_turn(monkeypatch, build_fn=empty_build, seen_vars=seen_vars)

    # No exec_policy → mode None → not code-edit → no gate.
    await run_turn(
        state=PhaseState.fresh("loop.stage", "DEVELOPER"),
        stage_key="loop.stage",
        agent_role="DEVELOPER",
        vars={"goal": "Read the code"},
        run_context={"capability_id": "cap-1"},
    )
    assert len(seen_vars) == 1  # turn proceeded past the build


def test_requires_min_context_rules():
    from context_api_service.app.governed.turn import _requires_min_context
    # Default: gate CODE_EDIT only.
    assert _requires_min_context({}, "CODE_EDIT", Phase.ACT) is True
    assert _requires_min_context({}, "REPO_READ_ONLY", Phase.ACT) is False
    assert _requires_min_context({}, None, Phase.ACT) is False
    # Explicit flag wins both ways.
    assert _requires_min_context({"require_min_context": False}, "CODE_EDIT", Phase.ACT) is False
    assert _requires_min_context({"require_min_context": True}, "REPO_READ_ONLY", Phase.ACT) is True


@pytest.mark.asyncio
async def test_resolve_code_context_budget_picks_tightest_cap(monkeypatch):
    from context_api_service.app.governed import turn as turn_mod

    async def fake_window(_alias):
        return 200_000  # → 50k at 0.25

    monkeypatch.setattr(turn_mod, "context_window_for", fake_window)

    pp = PhasePolicy(phase=Phase.ACT, allowed_tools=frozenset(), forbidden_tools=frozenset(),
                     required_output_schema={}, max_input_tokens=10_000,  # → 6000 at 0.6
                     max_output_tokens=None, max_tool_calls=None)
    policy = StagePolicy(policy_id="t", stage_key="s", agent_role="DEVELOPER", version=1,
                         status="ACTIVE", approval_model={},
                         limits={"max_code_context_tokens": 8000},
                         context_policy={}, edit_policy={}, verification_policy={},
                         risk_policy={}, phases={Phase.ACT: pp})
    budget = await turn_mod._resolve_code_context_budget(policy, Phase.ACT, None, "claude-sonnet-4-5")
    assert budget == 6000  # min(6000, 8000, 50000)


@pytest.mark.asyncio
async def test_resolve_code_context_budget_defaults_without_signals(monkeypatch):
    from context_api_service.app.governed import turn as turn_mod

    async def no_window(_alias):
        return None

    monkeypatch.setattr(turn_mod, "context_window_for", no_window)
    budget = await turn_mod._resolve_code_context_budget(None, Phase.PLAN, None, None)
    assert budget == turn_mod._CODE_CONTEXT_DEFAULT_BUDGET


# ── Prompt-capture cap + mask (code-context hardening E2) ─────────────────────


def test_sanitize_captured_messages_masks_and_caps(monkeypatch):
    from context_api_service.app.governed import turn as turn_mod
    monkeypatch.setattr(turn_mod, "_PROMPT_CAPTURE_MAX_CHARS", 40)  # force clipping
    msgs = [
        {"role": "system", "content": "call with Authorization: Bearer abcdef0123456789ABCDEF now"},
        {"role": "user", "content": "x" * 5000},
        {"role": "assistant"},   # no content key
        "not-a-dict",            # non-dict passthrough
    ]
    out = turn_mod._sanitize_captured_messages(msgs)
    # Originals are NOT mutated (these still go to the gateway verbatim).
    assert msgs[1]["content"] == "x" * 5000
    # Secret masked in the captured copy.
    assert "abcdef0123456789ABCDEF" not in out[0]["content"]
    assert "redacted" in out[0]["content"]
    # Oversized content clipped.
    assert "truncated" in out[1]["content"] and len(out[1]["content"]) < 5000
    # Missing-content dict + non-dict pass through unharmed.
    assert out[2] == {"role": "assistant"}
    assert out[3] == "not-a-dict"


def test_mask_secrets_redacts_token_shapes_but_keeps_code():
    from context_api_service.app.governed.turn import _mask_secrets
    assert "sk-" not in _mask_secrets("key=sk-ABCDEFGHIJKLMNOP12345")
    assert "ghp_" not in _mask_secrets("token ghp_0123456789abcdefghijABCDEF")
    assert "supersecretvalue123" not in _mask_secrets('"api_key": "supersecretvalue123"')
    code = "def foo(x):\n    return x + 1"
    assert _mask_secrets(code) == code  # ordinary code untouched


# ── Governance overlay compilation (G3) ──────────────────────────────────────


def test_render_governance_facts():
    from context_api_service.app.governed.turn import _render_governance_facts
    assert _render_governance_facts({}) == ""
    overlay = {
        "governingEntities": [{"capabilityId": "sec", "name": "Security Compliance"}],
        "promptLayers": [{"layerKey": "SEC_CONTROLS", "guidance": "Validate all inputs."},
                         {"layerKey": "ARCH"}],
        "requiredEvidence": [{"evidenceKey": "UNIT_TEST_RESULTS"}],
        "toolPolicy": {"blocked": ["prod_deploy"], "approvalRequired": ["git_push"]},
    }
    md = _render_governance_facts(overlay)
    assert md.startswith("## Governance for this stage")
    assert "Governed by: Security Compliance" in md
    assert "SEC_CONTROLS: Validate all inputs." in md
    assert "Apply governance guideline: ARCH." in md
    assert "UNIT_TEST_RESULTS" in md
    assert "prod_deploy" in md and "git_push" in md


@pytest.mark.asyncio
async def test_governance_overlay_renders_into_prompt_vars(monkeypatch):
    seen_vars: list[dict] = []

    async def fake_build(*, task_text, capability_id, run_context, **_kwargs):
        return ({"context_package_id": "c", "packageMarkdown": "x",
                 "target_symbols": [{"x": 1}], "editable_slices": [{"f": "a"}]}, None)

    _patch_context_turn(monkeypatch, build_fn=fake_build, seen_vars=seen_vars)
    await run_turn(
        state=PhaseState.fresh("loop.stage", "DEVELOPER"),
        stage_key="loop.stage", agent_role="DEVELOPER",
        vars={"goal": "do x"},
        run_context={"capability_id": "cap-1"},
        governance_overlay={
            "governingEntities": [{"capabilityId": "sec", "name": "Security"}],
            "promptLayers": [{"layerKey": "SEC", "guidance": "Be secure."}],
        },
    )
    assert seen_vars and "Governed by: Security" in (seen_vars[0].get("governance_facts") or "")
