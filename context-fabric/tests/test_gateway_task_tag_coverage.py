"""
Every gateway call site must set a task tag.

WHY THIS FILE EXISTS

GATEWAY_REQUIRE_TASK_TAG now defaults to on, so an untagged caller gets a 400
instead of a log line. That turns "we forgot to tag this one" from a reporting
gap into an outage, and there was NO repo-wide check that the set of call sites
and the set of tagged call sites were the same set. The existing task-tag tests
pin individual callers, one assertion per caller that someone remembered to
write — which is exactly the mechanism that let the untagged ones accumulate.

So this enumerates. It walks a checked-in manifest of every place in the repo
that POSTs a chat completion to the gateway, reads each file, and asserts a tag
is set. A new call site added without a tag fails here rather than in
production.

THIS TEST IS EXPECTED TO FAIL ON THIS BRANCH. That is the point.

The sites in PENDING_PR_578 are tagged by PR #578
(feat/gateway-caller-identity-propagation), which is NOT an ancestor of this
branch. This branch flips the flag; #578 does the tagging. The failure lists
exactly which callers would 400, so the blocker is visible in CI instead of
living in a PR description nobody reads at merge time.

It is self-clearing: nothing here hardcodes a failure. Once #578 lands, the same
assertions read the same files and pass with no edit. If it still fails after
#578, the coverage genuinely is not complete and the flag flip is not safe.

WHY NOT JUST DO THE TAGGING HERE

Because #578 already did it, across 30 files, and several of the sites cannot be
tagged without its type changes — agent-and-tools/packages/shared/src/llm-gateway
has no task_tag on either ChatCompletionRequest (types.ts) or the runtime zod
schema (client.ts), so no caller can pass one until that lands. Re-implementing
it here would mean two independent taggings of the same call sites in two open
PRs, and a guaranteed conflict when they meet.

SCOPE: chat completions only. Embeddings self-assign EMBEDDING in
resolve_task_identity before the requirement is checked, so an embeddings call
site cannot 400 for a missing tag and is not listed.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from llm_gateway_service.app import task_tags

_REPO_ROOT = Path(__file__).resolve().parents[2]


class Site:
    """One place that POSTs a chat completion to the gateway.

    `kind` distinguishes two genuinely different obligations:

      "sets"      — a leaf caller. It knows what it is doing and must name its
                    own bucket.
      "forwards"  — a shared transport with many unrelated callers. It must
                    PROPAGATE the caller's tag and must NOT stamp one, because a
                    hardcoded default here files every caller's spend under a
                    single wrong bucket — which looks correct and is therefore
                    worse than untagged.
    """

    def __init__(self, path: str, what: str, expected_tag: str = "", *,
                 kind: str = "sets", pending: str = ""):
        self.path = path
        self.what = what
        self.expected_tag = expected_tag
        self.kind = kind
        # Non-empty when another PR owns the fix, naming that PR.
        self.pending = pending

    def __repr__(self) -> str:
        return self.path


# Every chat-completion call site, verified by reading each file on this branch.
# Adding a caller means adding a row here; that is the intended friction.
CALL_SITES = [
    # ── tagged on this branch ────────────────────────────────────────────────
    Site(
        "context-fabric/services/context_api_service/app/governed/llm_client.py",
        "governed agent loop (cloud + laptop legs) — highest-volume agent path",
        "agent_turn",
    ),
    Site(
        "mcp-server/src/llm/client.ts",
        "mcp-server chat leg, used by the agent invoke loop",
        "agent_turn",
    ),
    Site(
        "agent-and-tools/apps/agent-runtime/src/modules/capabilities/bootstrap-phase3-distill.ts",
        "capability world-model distiller",
        "world_model_distill",
    ),
    Site(
        "agent-and-tools/apps/agent-runtime/src/modules/capabilities/world-model-view-builder.service.ts",
        "world-model view builder",
        "world_model_distill",
    ),
    Site(
        "claim-registry/src/lib/gateway.ts",
        "claim canonicalization / lowering",
        "claim_lowering",
    ),
    # ── tagged by THIS PR: gaps #578 does not cover ──────────────────────────
    Site(
        "tests/chaos/conftest.py",
        "chaos suite's call_gateway fixture — real HTTP, would 400 the whole suite",
        "harness",
    ),
    # ── owned by PR #578, absent from this branch ────────────────────────────
    Site(
        "agent-and-tools/packages/shared/src/llm-gateway/client.ts",
        "shared llmRespond — the D1 direct-to-gateway chat leg. A dozen "
        "unrelated callers share it, so it must forward theirs, not invent one. "
        "Blocks every caller behind it until #578: task_tag is on neither the TS "
        "interface nor the runtime zod schema, so nobody can pass one at all",
        kind="forwards",
        pending="#578",
    ),
    Site(
        "audit-governance-service/src/engine/llm-judge.ts",
        "audit-gov LLM judge",
        "judge",
        pending="#578",
    ),
    Site(
        "audit-governance-service/src/engine/diagnose.ts",
        "audit-gov trace diagnosis",
        "judge",
        pending="#578",
    ),
    Site(
        # #578 files this under `harness` rather than `judge`. Both are in the
        # vocabulary and it is a judgement call; the owning PR's choice governs,
        # and this row follows it so the two cannot silently disagree.
        "tools/capability-harness/scoring.py",
        "capability-harness scoring oracle",
        "harness",
        pending="#578",
    ),
    Site(
        "agent-and-tools/apps/agent-runtime/src/lib/llm/summarise.ts",
        "code summarisation — dead-ended behind the shared client above",
        "summarise",
        pending="#578",
    ),
    Site(
        "agent-and-tools/apps/prompt-composer/src/modules/compose/llm-capsule-compiler.ts",
        "context-capsule precompiler — dead-ended behind the shared client above",
        "capsule_compile",
        pending="#578",
    ),
]

# Deliberately not a parse: this has to work across Python and TypeScript, and a
# MISSING tag is unambiguous in any of them. Covers the four shapes actually in
# the tree:
#
#   task_tag: "agent_turn"                       TS object literal
#   task_tag: 'claim_lowering'                   TS, single quoted
#   "task_tag": "harness"                        Python dict / JSON body
#   body["task_tag"] = task_tag or "agent_turn"  Python assignment with a default
#
# The `[^"'\n]{0,40}` span is what admits that last one, where the literal is
# separated from the `=` by an override expression. A bare type declaration
# (`task_tag?: string`, `task_tag: str | None = None`) has no quoted lowercase
# literal and correctly does NOT count as tagging anything.
_TAG_RE = re.compile(r"""task_tag["']?\]?\s*[:=]\s*[^"'\n]{0,40}["']([a-z_]+)["']""")

# A transport forwarding a caller's tag: `task_tag: req.task_tag`, including
# inside a conditional spread.
_FORWARD_RE = re.compile(r"task_tag\s*:\s*\w+\.task_tag")
# …and declaring it on the request schema. Without a schema entry the field is
# stripped before it is ever sent, so a caller's tag looks set and silently is
# not — the failure mode is identical to never passing one.
_SCHEMA_RE = re.compile(r"task_tag\s*:\s*z\.")


def _read(site: Site) -> str:
    path = _REPO_ROOT / site.path
    if not path.exists():
        pytest.fail(
            f"call site no longer exists: {site.path}\n"
            f"  ({site.what})\n"
            "  If it moved, update CALL_SITES in this file. If the caller is "
            "gone, delete the row. Do NOT delete the row to make this pass."
        )
    return path.read_text(encoding="utf-8")


def _tags_in(site: Site) -> list[str]:
    return _TAG_RE.findall(_read(site))


def _is_wired(site: Site) -> bool:
    """Whether this site meets its own obligation — set a tag, or forward one."""
    if site.kind == "forwards":
        body = _read(site)
        return bool(_FORWARD_RE.search(body)) and bool(_SCHEMA_RE.search(body))
    return bool(_tags_in(site))


def _covered() -> list[Site]:
    return [s for s in CALL_SITES if not s.pending]


def _pending() -> list[Site]:
    return [s for s in CALL_SITES if s.pending]


# ── green on this branch: what this PR is responsible for ───────────────────

@pytest.mark.parametrize("site", _covered(), ids=lambda s: s.path)
def test_call_site_sets_a_task_tag(site: Site):
    """Regression guard. These are wired on this branch and must stay wired."""
    assert _is_wired(site), (
        f"UNTAGGED gateway call site: {site.path}\n"
        f"  {site.what}\n"
        f"  Expected task_tag={site.expected_tag!r}.\n"
        "  GATEWAY_REQUIRE_TASK_TAG defaults on, so this caller now gets a 400."
    )
    if site.kind == "sets":
        tags = _tags_in(site)
        assert site.expected_tag in tags, (
            f"{site.path} sets {tags} but this call site should send "
            f"{site.expected_tag!r} ({site.what})"
        )


@pytest.mark.parametrize(
    "site", [s for s in CALL_SITES if s.kind == "sets"], ids=lambda s: s.path,
)
def test_expected_tag_is_in_the_vocabulary(site: Site):
    """The vocabulary is closed and small on purpose. A manifest row naming a
    tag the gateway does not know would warn on every call from that site."""
    assert site.expected_tag in task_tags.KNOWN_TASK_TAGS, (
        f"{site.expected_tag!r} (for {site.path}) is not in KNOWN_TASK_TAGS. "
        "Use an existing bucket rather than inventing one — free-form tags "
        "fragment into a dozen spellings of the same thing."
    )


@pytest.mark.parametrize(
    "site", [s for s in CALL_SITES if s.kind == "forwards"], ids=lambda s: s.path,
)
def test_a_shared_transport_does_not_stamp_its_own_tag(site: Site):
    """A shared client must not hardcode a bucket. Every caller behind it has a
    different one, so a default here relabels all of them as one thing — and
    unlike an untagged call, that produces a confident wrong answer rather than
    an obvious gap."""
    stamped = [t for t in _tags_in(site) if t in task_tags.KNOWN_TASK_TAGS]
    assert not stamped, (
        f"{site.path} hardcodes {stamped}, but it is a shared transport "
        f"({site.what}). It must forward the caller's task_tag instead — a "
        "default here files every caller's spend under one wrong bucket."
    )


def test_every_tag_actually_found_is_a_known_tag():
    """Catches a typo'd tag at a real call site, which the gateway would accept
    and merely warn about — so the spend lands under a bucket nothing aggregates."""
    unknown: list[str] = []
    for site in CALL_SITES:
        for tag in _tags_in(site):
            if tag not in task_tags.KNOWN_TASK_TAGS:
                unknown.append(f"{site.path}: {tag!r}")
    assert not unknown, (
        "call sites send tags the gateway does not know:\n  "
        + "\n  ".join(unknown)
        + "\nThe gateway warns and passes these through, so they cost real money "
          "under a bucket no rollup counts."
    )


# ── failing by design until #578 lands ──────────────────────────────────────

def test_every_gateway_call_site_is_tagged():
    """FAILS ON THIS BRANCH BY DESIGN. See the module docstring.

    Self-clearing: it reads the real files, so it passes the moment #578 lands
    without anyone editing this test. Do not merge this branch while it is red —
    the flag flip 400s every caller listed below.
    """
    untagged = [s for s in CALL_SITES if not _is_wired(s)]
    assert not untagged, (
        "GATEWAY_REQUIRE_TASK_TAG defaults on, and these call sites send no "
        "task_tag. Every one of them will get a 400:\n\n"
        + "\n".join(
            f"  {s.path}\n"
            f"      {s.what}\n"
            + (
                "      needs to FORWARD the caller's task_tag (schema + body)"
                if s.kind == "forwards"
                else f"      needs task_tag={s.expected_tag!r}"
            )
            + (f"  [owned by PR {s.pending}]" if s.pending else "")
            for s in untagged
        )
        + "\n\nAll of these land in PR #578 (feat/gateway-caller-identity-"
          "propagation), which is not an ancestor of this branch. THIS BRANCH "
          "MUST NOT MERGE BEFORE #578. Rebasing onto #578 clears this with no "
          "edit to the test."
    )


def test_the_pending_set_is_documented_and_shrinking():
    """A guard on the guard. If someone empties PENDING by deleting rows instead
    of tagging call sites, the enumeration silently stops enumerating."""
    pending = _pending()
    for site in pending:
        assert site.pending == "#578", (
            f"{site.path} is marked pending on {site.pending!r}. Only #578 is a "
            "known owner; anything else needs its own explanation here."
        )
    # Every pending site must be a REAL file that really lacks a tag. A row that
    # is already tagged should have its `pending` marker removed, so the pending
    # set shrinks as work lands instead of going stale.
    already_done = [s.path for s in pending if _is_wired(s)]
    assert not already_done, (
        "these are marked pending on #578 but are already tagged:\n  "
        + "\n  ".join(already_done)
        + "\nDrop the `pending=` marker so they become regression-guarded."
    )
