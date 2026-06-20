"""
M73 — stage classification.

Decides what role a stage plays (dev / qa / story-only / research) and
which workspace operations it's allowed to perform. Pure functions over
`ExecuteRequest.vars`; no I/O. The legacy /execute path consults this to
filter the tool inventory; the new governed loop consults StagePolicy in
prompt-composer instead. Both code paths share these classifiers so the
two stay aligned.

Resolution rules:

  STORY_ONLY / NONE / !stageRepoAccess  → story-only stage (zero tools).
  CODE_EDIT  / MUTATION                 → DEVELOPER stage.
  VERIFY_ONLY / VERIFICATION            → QA stage.
  Otherwise                             → keyword inference over
                                          stageKey + stageLabel + agentRole.
                                          DEV signals win over QA signals.
                                          allow_autonomous_mutation forces DEV.

The classification deliberately tolerates loose inputs because the
workflow loop-definition layer hasn't always been strict about
contextPolicy/toolPolicy enums. The keyword fallback keeps older flows
working while the policy fields catch up.
"""
from __future__ import annotations

from typing import Any

# Local import — defined alongside ExecuteRequest in execute.py. Importing
# from the consumer side avoids a hard dep here on the request model so
# tests can pass a duck-typed object.

GOVERNANCE_MODES = {"fail_open", "fail_closed", "degraded", "human_approval_required"}


def governance_mode(value: str | None, *, fallback: str | None = None) -> str:
    """Normalise a governance-mode string.

    Legacy callers omit ``fallback`` and retain the historic fail-open default.
    Runtime execution paths should pass the deployment default so malformed
    caller input cannot silently downgrade a fail-closed environment.
    """
    fallback_mode = (fallback or "fail_open").strip().lower()
    if fallback_mode not in GOVERNANCE_MODES:
        fallback_mode = "fail_open"
    mode = (value or fallback_mode).strip().lower()
    return mode if mode in GOVERNANCE_MODES else fallback_mode


def stage_policy_value(req: Any, key: str) -> str:
    """Read a stage-policy enum field off `req.vars`. Upper-cases + replaces
    dashes so callers can use either `STORY_ONLY` or `story-only`."""
    value = req.vars.get(key)
    if isinstance(value, str):
        return value.strip().upper().replace("-", "_")
    return ""


def stage_repo_access(req: Any) -> bool:
    """Whether the stage has any repository access at all. Defaults True
    (most stages do); only story-only intake stages disable it."""
    value = req.vars.get("stageRepoAccess")
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return True


def stage_is_story_only(req: Any) -> bool:
    """True for stages that should see zero code tools. PRODUCT_OWNER
    intake is the canonical case."""
    context_policy = stage_policy_value(req, "stageContextPolicy")
    tool_policy = stage_policy_value(req, "stageToolPolicy")
    return (
        context_policy == "STORY_ONLY"
        or tool_policy == "NONE"
        or not stage_repo_access(req)
    )


def classify_stage_role(req: Any) -> tuple[bool, bool]:
    """Return (is_dev_stage, is_qa_stage). A stage is never both. Dev wins
    ties when both signals are present so an "autonomous mutation" stage
    labelled QA still gets the mutation toolkit.

    M43 — previously these two were collapsed into is_code_stage which
    gave QA stages mutation tools they should never have had.
    """
    context_policy = stage_policy_value(req, "stageContextPolicy")
    tool_policy = stage_policy_value(req, "stageToolPolicy")
    if context_policy == "STORY_ONLY" or tool_policy == "NONE":
        return False, False
    if context_policy == "CODE_EDIT" or tool_policy == "MUTATION":
        return True, False
    if context_policy == "VERIFY_ONLY" or tool_policy == "VERIFICATION":
        return False, True

    signature = " ".join([
        str(req.vars.get("stageKey") or ""),
        str(req.vars.get("stageLabel") or ""),
        str(req.vars.get("agentRole") or ""),
        req.task,
    ]).lower()
    has_dev = any(t in signature for t in ("develop", "developer", "engineer", "code"))
    has_qa = any(t in signature for t in ("qa", "quality", "test", "verify", "review"))
    is_dev = bool(getattr(req, "allow_autonomous_mutation", False) or has_dev)
    is_qa = bool(has_qa and not is_dev)
    return is_dev, is_qa
