"""
World-model grounding for the governed-stage loop.

WORKGRAPH_FORCE_GOVERNED_CODING defaults true, so most coding AGENT_TASK nodes
run through execute-governed-stage. That path resolves a phase-prompt TEMPLATE
rather than running a full compose, so it never received the capability world
model or the role views: the agents doing the most code work had the least
grounding. This closes that, and the tests are mostly about it staying safe.
"""
from __future__ import annotations

import asyncio

import pytest

from context_api_service.app.governed import stage_grounding as sg


@pytest.fixture(autouse=True)
def _clear_flag(monkeypatch):
    monkeypatch.delenv("CF_GOVERNED_STAGE_GROUNDING", raising=False)


def _view(**over):
    base = {"kind": "development", "domainKey": "", "title": "Development View", "contentMd": "Start in src/index.ts."}
    base.update(over)
    return base


# ── the flag ─────────────────────────────────────────────────────────────────
def test_on_by_default():
    """Coding agents most need to know the build system, the test commands and
    the shape of the repository. Leaving this off was the last place the layered
    world model did not reach."""
    assert sg.stage_grounding_enabled() is True


@pytest.mark.parametrize("off", ["0", "false", "FALSE", "no", "off"])
def test_can_be_reverted_by_env(monkeypatch, off):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", off)
    assert sg.stage_grounding_enabled() is False


def test_blank_means_the_default_not_disabled(monkeypatch):
    """An empty env var is "unset", not "off" -- a stray export must not silently
    strip grounding from every coding agent."""
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "")
    assert sg.stage_grounding_enabled() is True


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes", "on"])
def test_enabled_by_the_flag(monkeypatch, flag):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", flag)
    assert sg.stage_grounding_enabled() is True


def test_flag_is_read_per_call(monkeypatch):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "true")
    assert sg.stage_grounding_enabled() is True
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "false")
    assert sg.stage_grounding_enabled() is False


def test_fetch_returns_nothing_while_disabled(monkeypatch):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "false")
    result = asyncio.run(sg.fetch_stage_grounding(run_context={"capability_id": "cap-1"}, agent_role="developer"))
    assert result is None


# ── rendering ────────────────────────────────────────────────────────────────
def test_views_render_with_their_scope():
    block = sg.render_grounding_block(None, [_view()])
    assert block.startswith("## Capability grounding")
    assert "### Development View [development]" in block
    assert "Start in src/index.ts." in block


def test_a_keyed_view_shows_its_key():
    block = sg.render_grounding_block(None, [_view(kind="domain", domainKey="billing", title="Billing")])
    assert "[domain: billing]" in block


def test_a_stale_view_is_marked_not_dropped():
    """Grounding a commit behind still beats none; the note lets the model
    discount it."""
    block = sg.render_grounding_block(None, [_view(stale=True)])
    assert "may be out of date" in block
    assert "Start in src/index.ts." in block


def test_world_model_facts_render():
    block = sg.render_grounding_block(
        {
            "primaryLanguage": "typescript",
            "buildSystem": "pnpm",
            "testCommands": [{"kind": "unit", "cmd": "pnpm test"}],
            "readmeSummary": "A billing service.",
        },
        [],
    )
    assert "### Capability facts" in block
    assert "Primary language: typescript" in block
    assert "`pnpm test`" in block
    assert "A billing service." in block


def test_views_come_before_capability_facts():
    """Views are role-scoped and already budgeted by agent-runtime, so they are
    the higher-signal half. If the cap bites it should bite the generic model,
    not the view chosen for this specific agent."""
    block = sg.render_grounding_block({"primaryLanguage": "ts"}, [_view()])
    assert block.index("Development View") < block.index("Capability facts")


def test_nothing_worth_saying_renders_nothing():
    """No block at all is better than an empty heading in a coding prompt."""
    assert sg.render_grounding_block(None, None) is None
    assert sg.render_grounding_block(None, []) is None
    assert sg.render_grounding_block({}, []) is None
    assert sg.render_grounding_block({"unknownField": "x"}, []) is None
    assert sg.render_grounding_block(None, [_view(contentMd="   ")]) is None


def test_malformed_views_are_skipped_not_fatal():
    block = sg.render_grounding_block(None, ["garbage", None, 42, _view()])
    assert block is not None and "Development View" in block


def test_oversized_grounding_is_truncated_on_a_line_boundary():
    """The governed system message already carries stage rules and tool
    contracts; grounding that crowds them out has made the agent worse."""
    huge = _view(contentMd="\n".join(f"line {i} of the world model" for i in range(5000)))
    block = sg.render_grounding_block(None, [huge], max_chars=2000)
    assert len(block) <= 2000 + 200
    assert "grounding truncated" in block
    assert not block.endswith("line")


# ── degradation ──────────────────────────────────────────────────────────────
def test_no_capability_means_no_grounding(monkeypatch):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "true")
    assert asyncio.run(sg.fetch_stage_grounding(run_context={}, agent_role="developer")) is None
    assert asyncio.run(sg.fetch_stage_grounding(run_context=None, agent_role="developer")) is None


def test_fetch_never_raises_when_the_slice_blows_up(monkeypatch):
    """A stage that ran without grounding before must still run now -- a slow or
    broken agent-runtime cannot be allowed to fail a coding turn."""
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "true")

    async def _boom(*_a, **_kw):
        raise RuntimeError("agent-runtime is down")

    import context_api_service.app.execute_modules.prompt_context as pc

    monkeypatch.setattr(pc, "fetch_capability_world_model_slice", _boom)
    result = asyncio.run(
        sg.fetch_stage_grounding(run_context={"capability_id": "cap-1"}, agent_role="developer")
    )
    assert result is None


def test_fetch_renders_what_the_slice_returns(monkeypatch):
    monkeypatch.setenv("CF_GOVERNED_STAGE_GROUNDING", "true")

    async def _slice(*_a, **_kw):
        return {"primaryLanguage": "python"}, [_view()], None

    import context_api_service.app.execute_modules.prompt_context as pc
    from context_api_service.app.config import settings

    monkeypatch.setattr(pc, "fetch_capability_world_model_slice", _slice)
    monkeypatch.setattr(settings, "agent_runtime_url", "http://runtime", raising=False)
    block = asyncio.run(
        sg.fetch_stage_grounding(run_context={"capability_id": "cap-1"}, agent_role="developer")
    )
    assert block and "Development View" in block and "python" in block


# ── message assembly ─────────────────────────────────────────────────────────
def test_grounding_leads_the_system_message():
    """Grounding is context the stage rules then act on. Appending it after the
    contract would read as an afterthought."""
    from context_api_service.app.governed.turn import _build_messages
    from context_api_service.app.governed.prompt_resolver import ResolvedPrompt

    prompt = ResolvedPrompt(
        task="Implement the thing.",
        system_prompt_append="You are in the DEVELOP phase.",
        extra_context="",
        prompt_profile_id="profile-1",
        binding_id="binding-1",
        stage_key="develop",
        agent_role="developer",
        phase="DEVELOP",
    )
    messages = _build_messages(prompt, [], "## Capability grounding\n\nfacts here")
    assert messages[0]["role"] == "system"
    content = messages[0]["content"]
    assert content.index("Capability grounding") < content.index("DEVELOP phase")


def test_no_grounding_leaves_the_system_message_untouched():
    """The default path must be byte-identical to today."""
    from context_api_service.app.governed.turn import _build_messages
    from context_api_service.app.governed.prompt_resolver import ResolvedPrompt

    prompt = ResolvedPrompt(
        task="Implement the thing.",
        system_prompt_append="You are in the DEVELOP phase.",
        extra_context="",
        prompt_profile_id="profile-1",
        binding_id="binding-1",
        stage_key="develop",
        agent_role="developer",
        phase="DEVELOP",
    )
    for grounding in (None, "", "   "):
        messages = _build_messages(prompt, [], grounding)
        assert messages[0]["content"] == "You are in the DEVELOP phase."
