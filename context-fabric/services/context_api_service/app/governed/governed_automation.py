"""
M99 (2026-05-30) — Phase 0 automation resolver.

The "Centralize Agentic Coding Around Context Fabric" spec proposes four
platform-driven automation behaviors (localization, baseline, verify,
git-preflight) that the operator can switch per stage. Each behavior is
gated by TWO independent switches:

  1. An env rollout flag (ops-level kill switch, default OFF) so the new
     codepaths can ship dark and be enabled per environment.
  2. A StageExecutionPolicy flag (per-stage opt-in) set by the workflow
     designer (see stage_execution_policy.py auto_localize / auto_baseline
     / auto_verify / git_preflight_required).

A behavior runs ONLY when BOTH are on. Because every env flag defaults to
OFF, Phase 0 is a strict no-op: `automation_enabled(...)` returns False for
every behavior regardless of policy, so the legacy hardcoded/model-driven
paths stay in force. Flipping an env flag in a later rollout phase then
lets the per-stage policy flag take effect.

This module is the single source of truth for that AND so callers don't
re-implement the env+policy combination inconsistently.
"""
from __future__ import annotations

import os
from typing import Literal, Optional

from .stage_execution_policy import StageExecutionPolicy

Behavior = Literal["localize", "baseline", "verify", "preflight"]

# Behavior → (env rollout flag, StageExecutionPolicy attribute).
_BEHAVIOR_ENV: dict[str, str] = {
    "localize": "CF_AGENTIC_CODING_V2_ENABLED",
    "baseline": "CF_AUTO_BASELINE_ENABLED",
    "verify": "CF_AUTO_VERIFY_ENABLED",
    "preflight": "CF_GIT_PREFLIGHT_ENABLED",
}
_BEHAVIOR_POLICY_ATTR: dict[str, str] = {
    "localize": "auto_localize",
    "baseline": "auto_baseline",
    "verify": "auto_verify",
    "preflight": "git_preflight_required",
}

_FALSEY = {"0", "false", "no", "off", "", "none"}


def env_flag_enabled(name: str, *, default: bool = False) -> bool:
    """Read a boolean env rollout flag. Unset → `default` (False)."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _FALSEY


def automation_enabled(
    policy: Optional[StageExecutionPolicy],
    behavior: Behavior,
) -> bool:
    """True iff `behavior` should run the M99 platform-driven codepath.

    Requires BOTH the env rollout flag AND the per-stage policy flag
    (policy attribute is True). A None policy, a None/False policy flag,
    or an unset/false env flag all yield False. With every env flag
    defaulting OFF this returns False everywhere in Phase 0.
    """
    env_name = _BEHAVIOR_ENV[behavior]
    if not env_flag_enabled(env_name):
        return False
    if policy is None:
        return False
    return getattr(policy, _BEHAVIOR_POLICY_ATTR[behavior], None) is True


def force_governed_coding() -> bool:
    """Workgraph-side mirror flag, read here only for parity/diagnostics.

    The authoritative use of WORKGRAPH_FORCE_GOVERNED_CODING lives in
    workgraph-api (AgentTaskExecutor); CF exposes the reader so audit
    payloads can record what the platform believed the rollout state was.
    """
    return env_flag_enabled("WORKGRAPH_FORCE_GOVERNED_CODING")
