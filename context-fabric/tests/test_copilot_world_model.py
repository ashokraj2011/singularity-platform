"""The copilot executor must be grounded in the capability world model.

Copilot was the one execution path that received neither the composed prompt nor
the governed loop's stage grounding: `compose_copilot_prompt` built its prompt
locally and only ever reached for a DISTILLED world model as a fallback, when the
code-context build had already failed. So the agent that edits files directly and
unattended was the one running without the repo's own agent rules, build system
and test commands — silently, because on the happy path nothing was logged.

These tests pin the fix and, more importantly, its safety: grounding is context,
never a reason to fail a stage.
"""
from __future__ import annotations

import asyncio

import pytest

from context_api_service.app.governed import copilot_executor as ce


@pytest.fixture(autouse=True)
def _grounding_on(monkeypatch):
    monkeypatch.delenv("CF_GOVERNED_STAGE_GROUNDING", raising=False)


def _compose(**over):
    kwargs = {
        "stage_key": "develop",
        "agent_role": "developer",
        "capability_id": "cap-1",
        "resolved_task": "Add a health endpoint.",
        "vars": {},
        "run_context": {"capability_id": "cap-1"},
        "bearer": None,
    }
    kwargs.update(over)
    return asyncio.run(ce.compose_copilot_prompt(**kwargs))


def _stub_code_context(monkeypatch, *, markdown: str | None = None, reason: str | None = None):
    """Stub the live code-context build. `markdown=None` means "unavailable"."""
    async def _build(**_kw):
        return ({"pkg": True} if markdown else None), reason

    monkeypatch.setattr(ce, "build_code_context_for_governed_turn", _build)
    monkeypatch.setattr(ce, "package_markdown", lambda _pkg: markdown or "")


def _stub_grounding(monkeypatch, block: str | None):
    async def _fetch(**_kw):
        return block

    monkeypatch.setattr(ce, "fetch_stage_grounding", _fetch)


def _stub_distilled(monkeypatch, text: str | None):
    async def _fetch(*_a, **_kw):
        return text

    monkeypatch.setattr(ce, "_fetch_distilled_world_model", _fetch)


# ── the fix: the world model is on the HAPPY path ────────────────────────────
def test_world_model_is_in_the_prompt_alongside_the_code_context(monkeypatch):
    """The two are different things and copilot needs both: the code slice says
    which files matter, the world model says how the repo expects to be worked in."""
    _stub_code_context(monkeypatch, markdown="src/app.py is the entrypoint.")
    _stub_grounding(monkeypatch, "## Capability grounding\n\n- Test commands: `pytest -q`")
    _stub_distilled(monkeypatch, None)

    prompt = _compose()

    assert "## Capability grounding" in prompt
    assert "pytest -q" in prompt
    # Not an either/or with the code context — that was never the tension.
    assert "src/app.py is the entrypoint." in prompt


def test_world_model_arrives_even_when_code_context_succeeds(monkeypatch):
    """The regression this whole change is about: previously the world model was
    reached ONLY as a fallback after code-context failed, so a healthy run — the
    common case — got no agent rules at all."""
    _stub_code_context(monkeypatch, markdown="a healthy code slice")
    _stub_grounding(monkeypatch, "## Capability grounding\n\n- Build system: pnpm")

    called = {"distilled": False}

    async def _distilled(*_a, **_kw):
        called["distilled"] = True
        return "distilled text"

    monkeypatch.setattr(ce, "_fetch_distilled_world_model", _distilled)

    prompt = _compose()

    assert "Build system: pnpm" in prompt
    # And the crude distilled render is not fetched at all when the real slice
    # already answered — it is the same data, rendered worse, at the cost of a
    # second round-trip.
    assert called["distilled"] is False


def test_role_is_passed_through_so_the_slice_is_role_scoped(monkeypatch):
    """Copilot must get the SAME narrow role view as every governed agent, not the
    capability-wide model."""
    seen: dict = {}

    async def _fetch(**kw):
        seen.update(kw)
        return "## Capability grounding\n\n- ok"

    monkeypatch.setattr(ce, "fetch_stage_grounding", _fetch)
    _stub_code_context(monkeypatch, markdown="code")
    _stub_distilled(monkeypatch, None)

    _compose(agent_role="tester")

    assert seen["agent_role"] == "tester"
    # The task rides along too: the slice endpoint uses it to pick views.
    assert seen["task"] == "Add a health endpoint."


def test_capability_id_argument_reaches_grounding_when_run_context_lacks_it(monkeypatch):
    """The copilot-handoff EXPORT passes capability_id as its own argument and its
    run_context need not carry one. Without this, exports would silently compose
    ungrounded prompts."""
    seen: dict = {}

    async def _fetch(**kw):
        seen.update(kw)
        return "## Capability grounding\n\n- ok"

    monkeypatch.setattr(ce, "fetch_stage_grounding", _fetch)
    _stub_code_context(monkeypatch, markdown="code")
    _stub_distilled(monkeypatch, None)

    _compose(run_context={}, capability_id="cap-from-arg")

    assert seen["run_context"]["capability_id"] == "cap-from-arg"


# ── degradation: grounding never fails a stage ───────────────────────────────
def test_a_world_model_failure_degrades_rather_than_failing_the_stage(monkeypatch):
    """A slow or broken agent-runtime must not take out a copilot coding stage —
    the export explicitly falls back to the raw task rather than erroring."""
    async def _boom(**_kw):
        raise RuntimeError("agent-runtime is down")

    monkeypatch.setattr(ce, "fetch_stage_grounding", _boom)
    _stub_code_context(monkeypatch, markdown="a healthy code slice")
    _stub_distilled(monkeypatch, None)

    prompt = _compose()

    # Composed, not raised — and the rest of the prompt is intact.
    assert "Add a health endpoint." in prompt
    assert "a healthy code slice" in prompt


def test_grounding_failure_with_no_code_context_still_composes(monkeypatch):
    """Worst case: both grounding and code context are unavailable. The stage must
    still get a usable prompt, with an honest diagnostic rather than silence."""
    async def _boom(**_kw):
        raise RuntimeError("agent-runtime is down")

    monkeypatch.setattr(ce, "fetch_stage_grounding", _boom)
    _stub_code_context(monkeypatch, markdown=None, reason="code_context.skipped: no index")
    _stub_distilled(monkeypatch, None)

    prompt = _compose()

    assert "Add a health endpoint." in prompt
    assert "Unavailable for this run" in prompt
    assert "code_context.skipped: no index" in prompt
    # The grounding miss is reported too, not swallowed behind the code-context one.
    assert "agent-runtime is down" in prompt


def test_no_capability_id_is_not_an_error(monkeypatch):
    """A stage with no capability composes exactly as before."""
    _stub_code_context(monkeypatch, markdown="code")
    _stub_distilled(monkeypatch, None)

    prompt = _compose(capability_id=None, run_context={})

    assert "Add a health endpoint." in prompt


# ── the reshaped fallback ────────────────────────────────────────────────────
def test_distilled_fallback_still_applies_when_nothing_else_is_available(monkeypatch):
    """The distilled model remains the last resort — it just stopped being the
    ONLY path. Removing it would have made the worst case worse."""
    _stub_code_context(monkeypatch, markdown=None, reason="code_context.skipped: bridge down")
    _stub_grounding(monkeypatch, None)
    _stub_distilled(monkeypatch, "- **Stack:** python / poetry")

    prompt = _compose()

    assert "Repository world model (capability knowledge)" in prompt
    assert "python / poetry" in prompt


def test_no_apology_in_the_prompt_when_grounding_carried_the_run(monkeypatch):
    """Code context missing but grounding present: the agent is genuinely grounded,
    so the prompt should not tell it to go build context from scratch."""
    _stub_code_context(monkeypatch, markdown=None, reason="code_context.skipped: bridge down")
    _stub_grounding(monkeypatch, "## Capability grounding\n\n- Build system: pnpm")
    _stub_distilled(monkeypatch, None)

    prompt = _compose()

    assert "Build system: pnpm" in prompt
    assert "Unavailable for this run" not in prompt


def test_prompt_override_still_wins_verbatim(monkeypatch):
    """An operator-edited prompt is used as-is — grounding must not be appended to
    (or trigger a fetch for) a prompt the operator already approved on screen."""
    called = {"grounding": False}

    async def _fetch(**_kw):
        called["grounding"] = True
        return "## Capability grounding\n\n- nope"

    monkeypatch.setattr(ce, "fetch_stage_grounding", _fetch)

    prompt = _compose(run_context={"capability_id": "cap-1", "prompt_override": "  just do it  "})

    assert prompt == "just do it"
    assert called["grounding"] is False
