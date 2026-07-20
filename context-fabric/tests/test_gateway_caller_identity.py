"""
Caller identity on the gateway hop.

The parent commit added optional actor_id / tenant_id / session_id to the gateway
request types. Nothing set them, so the fields existed and every request was still
anonymous — "what did this user's LLM traffic cost today" stayed unanswerable.
This suite pins the propagation.

Two invariants worth stating outright, because both are easy to regress into
something that LOOKS right:

  1. An unresolvable field is ABSENT from the body, never null. `actor_id: null`
     and "no actor_id key" are the same on the wire, but they are not the same in
     a code review — the convention is that a background caller sends
     "system:<service-name>", so a null actor means somebody forgot to propagate
     one. Fabricating a value to avoid the null destroys that signal.

  2. These are ATTRIBUTION, NOT AUTHORIZATION. The gateway is behind a single
     shared bearer, so any caller can claim any actor or tenant. Good enough for
     cost reporting; categorically not a basis for tenant isolation. The last
     test in this file exists to say so where someone will actually read it.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from context_api_service.app.governed.llm_client import _build_chat_body, caller_identity
from llm_gateway_service.app import task_tags


REPO_ROOT = Path(__file__).resolve().parents[2]


def _call_args(source: str, marker: str) -> str:
    """Return the argument text of the call that starts at `marker`.

    Balances parentheses rather than splitting on the first ")" — these call
    sites contain nested calls and prose comments, so a naive split silently
    truncates and the guard passes on a fragment.
    """
    start = source.index(marker) + len(marker)
    depth = 1
    for i in range(start, len(source)):
        if source[i] == "(":
            depth += 1
        elif source[i] == ")":
            depth -= 1
            if depth == 0:
                return source[start:i]
    raise AssertionError(f"unbalanced parens after {marker!r}")


def _body(**kwargs):
    """_build_chat_body with the boilerplate every test would otherwise repeat."""
    base = dict(
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        model_alias=None,
        expected_provider=None,
        expected_model=None,
        temperature=None,
        max_output_tokens=None,
        thinking_budget=None,
        prompt_cache=False,
        prompt_cache_key=None,
    )
    base.update(kwargs)
    return _build_chat_body(**base)


# ── extraction ───────────────────────────────────────────────────────────────
def test_identity_is_read_the_same_way_audit_emit_reads_it():
    """audit_emit.py has always pulled actor from user_id and tenant from
    tenant_id. The identity was never missing from context-fabric; it just never
    crossed the gateway hop. Same keys here, deliberately."""
    ident = caller_identity({"user_id": "u-1", "tenant_id": "t-1"})
    assert ident["actor_id"] == "u-1"
    assert ident["tenant_id"] == "t-1"


def test_identity_accepts_camel_case_run_contexts():
    """workgraph-api ships camelCase; CF's own callers ship snake_case. Both
    reach this function, and placement.py already tolerates both."""
    ident = caller_identity({"userId": "u-2", "tenantId": "t-2", "sessionId": "s-2"})
    assert ident == {"actor_id": "u-2", "tenant_id": "t-2", "session_id": "s-2"}


def test_an_explicit_actor_id_beats_the_user_id():
    """How a background caller declares itself: agent-service puts
    actor_id="system:agent-service" in run_context and CF forwards it verbatim."""
    ident = caller_identity({"actor_id": "system:agent-service", "user_id": "u-3"})
    assert ident["actor_id"] == "system:agent-service"


def test_unresolvable_fields_are_absent_not_none():
    """The whole point of the convention. A null actor_id would read as "no human
    involved" when it actually means "nobody propagated one" — so we emit no key
    at all and let the gateway's own missing-field handling see the gap."""
    ident = caller_identity({})
    assert ident == {}
    assert "actor_id" not in ident

    body = _body(run_context={})
    assert "actor_id" not in body
    assert "tenant_id" not in body
    assert "session_id" not in body


def test_no_run_context_at_all_is_survivable():
    assert caller_identity(None) == {}
    assert "actor_id" not in _body(run_context=None)


def test_session_falls_back_to_the_key_cf_already_uses_for_conversations():
    """execute.py:513 already derives `wf:<instance>:<node>` as the session key
    for memory storage. Reusing that expression means a cost row groups by the
    same session the transcript does, rather than by a second notion of
    "conversation" that happens to be spelled differently."""
    ident = caller_identity({"workflow_instance_id": "wf-9", "workflow_node_id": "n-4"})
    assert ident["session_id"] == "wf:wf-9:n-4"


def test_an_explicit_session_id_beats_the_derived_one():
    ident = caller_identity({
        "session_id": "chat-77",
        "workflow_instance_id": "wf-9",
        "workflow_node_id": "n-4",
    })
    assert ident["session_id"] == "chat-77"


def test_a_partial_workflow_context_derives_no_session():
    """Half a key is not a session. Better to send nothing than an id like
    `wf:wf-9:None` that looks real and joins to nothing."""
    assert "session_id" not in caller_identity({"workflow_instance_id": "wf-9"})


def test_tenant_accepts_the_org_id_spelling():
    """placement.runtime_tenant_target already treats org_id as a tenant, so the
    two would otherwise disagree about whether a run has a tenant."""
    assert caller_identity({"org_id": "org-5"})["tenant_id"] == "org-5"


def test_identity_values_are_stringified():
    """A uuid object or int from a JSON-ish run_context must not reach the wire
    as a non-string — the gateway's model declares these Optional[str]."""
    ident = caller_identity({"user_id": 12345, "tenant_id": 6789})
    assert ident == {"actor_id": "12345", "tenant_id": "6789"}


# ── it actually rides the gateway body ───────────────────────────────────────
def test_identity_rides_the_gateway_body():
    """The load-bearing assertion of this whole change."""
    body = _body(run_context={
        "user_id": "u-42",
        "tenant_id": "t-7",
        "session_id": "sess-3",
    })
    assert body["actor_id"] == "u-42"
    assert body["tenant_id"] == "t-7"
    assert body["session_id"] == "sess-3"


def test_the_laptop_path_gains_attribution_for_free():
    """_build_chat_body is shared by the cloud-gateway path and the laptop
    `model-run` path so both send byte-identical requests. That is not incidental
    here: it means BYO-laptop traffic — the traffic least visible to central
    operators — becomes attributable without a second wiring."""
    import inspect

    from context_api_service.app.governed import llm_client

    source = inspect.getsource(llm_client.call_gateway_chat)
    # One body, built once, used by both branches: the laptop dispatch below the
    # build reuses `body` rather than assembling its own.
    assert source.count("_build_chat_body(") == 1
    assert "_try_laptop_chat(" in source
    assert "run_context=run_context" in source


def test_a_background_caller_never_sends_a_null_actor():
    """system:<service-name> is the contract for callers with no human behind
    them. Asserted on the BODY, because a helper that returns the right thing and
    a body that carries it are different claims."""
    body = _body(run_context={"actor_id": "system:agent-service"})
    assert body["actor_id"] == "system:agent-service"
    assert body["actor_id"] is not None
    assert body["actor_id"].startswith("system:")


def test_identity_does_not_disturb_the_task_tag_default():
    """The parent change's governed-loop default has to survive this one."""
    body = _body(run_context={"user_id": "u-1"})
    assert body["task_tag"] == "agent_turn"


# ── task tag, now also reachable from run_context ────────────────────────────
def test_run_context_can_carry_the_task_tag():
    """/execute-governed-single-turn has no task_tag field of its own, so its
    callers (agent-service distillation, tool-service synthesis) declare the tag
    in run_context. Without this they would all be filed as `agent_turn` —
    background distillation billed as interactive agent spend."""
    body = _body(run_context={"task_tag": "world_model_distill"})
    assert body["task_tag"] == "world_model_distill"
    assert body["task_tag"] in task_tags.KNOWN_TASK_TAGS


def test_an_explicit_argument_still_beats_the_run_context_tag():
    body = _body(task_tag="planning", run_context={"task_tag": "summarise"})
    assert body["task_tag"] == "planning"


def test_run_context_task_tag_accepts_camel_case():
    assert _body(run_context={"taskTag": "judge"})["task_tag"] == "judge"


# ── the callers that had to be re-wired ──────────────────────────────────────
def test_the_governed_loop_forwards_its_run_context():
    """turn.py holds the run_context that audit_emit already stamps events from.
    If it stops passing it here, the audit trail keeps naming the actor while the
    LLM cost row for the same stage goes anonymous again — a silent regression,
    since nothing fails."""
    source = (
        REPO_ROOT / "context-fabric/services/context_api_service/app/governed/turn.py"
    ).read_text()
    call = _call_args(source, "response = await call_gateway_chat(")
    assert "run_context=run_context" in call


def test_the_single_turn_endpoint_forwards_its_run_context():
    source = (
        REPO_ROOT / "context-fabric/services/context_api_service/app/execute.py"
    ).read_text()
    call = _call_args(source, "resp = await call_gateway_chat(")
    assert "run_context=rc" in call


# ── the previously-untagged call sites, across the platform ──────────────────
# Each entry: (path, the tags it must send, whether it must name an actor).
#
# These are source-text assertions rather than behavioural ones on purpose: the
# call sites live in five languages-worth of services with no shared test
# harness, and the failure being guarded against is a caller QUIETLY dropping a
# field — which no runtime test in this repo would catch, because an untagged
# call still succeeds today. It only starts failing when someone flips
# GATEWAY_REQUIRE_TASK_TAG in production.
_MIGRATED_CALL_SITES = [
    ("audit-governance-service/src/engine/llm-judge.ts", ["judge"], True),
    ("audit-governance-service/src/engine/diagnose.ts", ["judge"], True),
    (
        "agent-and-tools/apps/prompt-composer/src/modules/compose/llm-capsule-compiler.ts",
        ["capsule_compile"],
        True,
    ),
    ("agent-and-tools/apps/agent-runtime/src/lib/llm/summarise.ts", ["summarise"], True),
    (
        "agent-and-tools/apps/agent-service/src/routes/runtime.ts",
        ["world_model_distill"],
        True,
    ),
    (
        "agent-and-tools/apps/agent-service/src/tool/routes/internal-tools.ts",
        ["summarise", "direct_llm_task"],
        True,
    ),
    ("tools/capability-harness/scoring.py", ["harness"], True),
    # Tagged by the earlier W2-1 pass, but anonymous until this change.
    (
        "agent-and-tools/apps/agent-runtime/src/modules/capabilities/bootstrap-phase3-distill.ts",
        ["world_model_distill"],
        True,
    ),
    (
        "agent-and-tools/apps/agent-runtime/src/modules/capabilities/world-model-view-builder.service.ts",
        ["world_model_distill"],
        True,
    ),
    ("claim-registry/src/lib/gateway.ts", ["claim_lowering"], True),
]


@pytest.mark.parametrize("relative,tags,needs_actor", _MIGRATED_CALL_SITES)
def test_every_migrated_call_site_sends_a_tag_from_the_vocabulary(relative, tags, needs_actor):
    source = (REPO_ROOT / relative).read_text()
    for tag in tags:
        assert tag in task_tags.KNOWN_TASK_TAGS, (
            f"{relative} sends task_tag={tag!r}, which is not in the gateway "
            f"vocabulary — add it to task_tags.KNOWN_TASK_TAGS or use an existing value"
        )
        assert re.search(rf"""task_?[tT]ag['"]?\s*[:=]\s*['"]{tag}['"]""", source), (
            f"{relative} no longer sends task_tag={tag!r}; it would 400 once "
            f"GATEWAY_REQUIRE_TASK_TAG is set"
        )
    if needs_actor:
        assert re.search(r"""actor_?[iI]d['"]?\s*[:=]""", source), (
            f"{relative} sends no actor_id — a background caller must send "
            f'"system:<service-name>", not nothing'
        )


@pytest.mark.parametrize("relative,tags,needs_actor", _MIGRATED_CALL_SITES)
def test_no_call_site_claims_a_null_actor(relative, tags, needs_actor):
    """The guard that keeps the convention meaningful. `actor_id: null` is worse
    than a missing key: it looks propagated. If a caller genuinely has no actor
    it sends "system:<service>"; if it genuinely cannot know, it sends nothing
    and that gap stays visible."""
    source = (REPO_ROOT / relative).read_text()
    for null_ish in ("actor_id: null", "actor_id: undefined", '"actor_id": None', "actor_id=None"):
        assert null_ish not in source, f"{relative} sets {null_ish}"


def test_system_actors_name_a_real_service():
    """`system:` alone would be as uninformative as null. The suffix is what
    makes a cost report able to say WHICH background service spent the money.

    Scans every system-actor LITERAL, not just direct actor_id assignments:
    several sites route the value through a shared constant or a
    `user ?? fallback`, and those spellings are exactly the ones that could
    quietly degrade to a bare prefix."""
    literal = re.compile(r"""['"]system:([^'"]*)['"]""")
    seen = 0
    for relative, _tags, needs_actor in _MIGRATED_CALL_SITES:
        if not needs_actor:
            continue
        source = (REPO_ROOT / relative).read_text()
        for service in literal.findall(source):
            seen += 1
            assert len(service) > 2, (
                f"{relative} claims a bare/short system actor 'system:{service}' — "
                f"the suffix is what lets a cost report attribute the spend"
            )
    assert seen >= 8, f"expected a system actor in most migrated sites, found {seen}"


def test_the_tags_this_change_introduces_are_all_in_the_vocabulary():
    """A tag outside the vocabulary is not rejected — it passes through with a
    warning — so a typo would ship silently and fragment the aggregation it was
    supposed to enable."""
    for tag in ["judge", "capsule_compile", "summarise", "world_model_distill",
                "direct_llm_task", "harness", "claim_lowering"]:
        assert tag in task_tags.KNOWN_TASK_TAGS


# ── the caveat, written where it will be read ────────────────────────────────
def test_identity_is_documented_as_attribution_not_authorization():
    """Someone will eventually try to build tenant isolation on tenant_id. The
    gateway sits behind ONE shared bearer, so a tenant_id is a claim, not a
    verified fact — anything can assert anything. This test exists so that the
    warning cannot be quietly deleted from the code it applies to."""
    source = (
        REPO_ROOT / "context-fabric/services/context_api_service/app/governed/llm_client.py"
    ).read_text()
    lowered = source.lower()
    assert "attribution, not authorization" in lowered
    assert "isolation" in lowered
