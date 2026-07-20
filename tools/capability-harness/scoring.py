"""Three scoring oracles for the capability harness.

Each oracle is a pure function: takes the task + the agent's response
+ optional config, returns an OracleResult. Composition into a
TaskScore lives in `score_task()`. Pure-function design lets the
unit tests exercise each oracle in isolation without needing a
running CF or llm-gateway.

The three oracles mirror the spec (M74 Phase 4A §4A):

  1. diff_matches_reference  — text compare vs gold patch
  2. llm_judge               — rubric-driven LLM evaluation
  3. tests_pass              — failing tests pass against agent output
                               (Slice 1 STUB; Slice 2 wires real
                               sandboxed test execution)

A task passes the harness when at least 2 of 3 oracles vote "pass"
(majority rule). Configurable via score_task's threshold_majority
arg if a stricter all-must-pass rule is preferred later.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from dataclasses import dataclass, field
from typing import Any


# ── Oracle result envelope ──────────────────────────────────────────────────


@dataclass(frozen=True)
class OracleResult:
    """One oracle's verdict on one task."""

    name: str
    passed: bool
    score: float  # 0.0-1.0; for the LLM judge this is the normalised score
    reason: str   # human-readable
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TaskScore:
    """Composite score across all oracles for one task."""

    task_id: str
    passed: bool
    oracles: list[OracleResult]

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "passed": self.passed,
            "oracles": [
                {
                    "name": o.name,
                    "passed": o.passed,
                    "score": o.score,
                    "reason": o.reason,
                    "details": o.details,
                }
                for o in self.oracles
            ],
        }


# ── Oracle 1: diff matches reference ────────────────────────────────────────


_WS_NORMALISE_RE = re.compile(r"\s+")


def _normalise_for_diff(text: str) -> str:
    """Strip leading/trailing whitespace and collapse runs of whitespace
    to single spaces. Permissive on purpose — a hand-formatted reference
    shouldn't fail a semantically-identical agent output over a single
    blank line or tab vs spaces."""
    return _WS_NORMALISE_RE.sub(" ", text or "").strip()


def oracle_diff_matches_reference(
    *,
    agent_output: str,
    reference_patch: str,
    min_overlap_ratio: float = 0.75,
) -> OracleResult:
    """Text-overlap oracle. Computes a normalised-set Jaccard score
    on the lines of agent_output vs reference_patch. Passes when the
    score is >= min_overlap_ratio (default 0.75).

    Why Jaccard not exact match: agents legitimately produce
    differently-ordered or differently-commented patches that solve
    the same problem. Exact-match would have ~0% pass rate even on
    perfect runs. Why not a real AST diff: deferred — the LLM judge
    catches semantic correctness, this oracle is the cheap-and-fast
    "did the agent at least produce something patch-shaped that
    overlaps the gold"."""
    norm_agent = _normalise_for_diff(agent_output)
    norm_ref = _normalise_for_diff(reference_patch)
    if not norm_ref:
        return OracleResult(
            name="diff_matches_reference",
            passed=False,
            score=0.0,
            reason="reference_patch is empty — corpus bug",
        )

    agent_lines = {line.strip() for line in norm_agent.split(" ") if line.strip()}
    ref_lines = {line.strip() for line in norm_ref.split(" ") if line.strip()}
    if not agent_lines:
        return OracleResult(
            name="diff_matches_reference",
            passed=False,
            score=0.0,
            reason="agent produced no output",
        )

    intersection = len(agent_lines & ref_lines)
    union = len(agent_lines | ref_lines)
    ratio = intersection / union if union else 0.0
    passed = ratio >= min_overlap_ratio
    return OracleResult(
        name="diff_matches_reference",
        passed=passed,
        score=ratio,
        reason=(
            f"jaccard overlap {ratio:.2f} >= {min_overlap_ratio:.2f}"
            if passed
            else f"jaccard overlap {ratio:.2f} below threshold {min_overlap_ratio:.2f}"
        ),
        details={
            "ratio": ratio,
            "min_overlap_ratio": min_overlap_ratio,
            "agent_token_count": len(agent_lines),
            "reference_token_count": len(ref_lines),
        },
    )


# ── Oracle 2: LLM judge ─────────────────────────────────────────────────────

_JUDGE_SYSTEM_PROMPT = (
    "You are an expert code reviewer evaluating an agent's output against a rubric.\n"
    "Score the agent's output on a 1-5 scale per the rubric:\n"
    "  1 = wrong / unusable\n"
    "  2 = mostly wrong, partial credit\n"
    "  3 = passable, has issues\n"
    "  4 = good, minor nits\n"
    "  5 = correct and well-formed\n\n"
    'Respond with ONLY a JSON object: {"score": <1-5 int>, "reason": "<one sentence>"}'
)


def _judge_user_prompt(rubric: str, agent_output: str, reference: str) -> str:
    return (
        f"## Rubric\n{rubric}\n\n"
        f"## Reference solution (the baseline you're scoring against)\n```\n{reference}\n```\n\n"
        f"## Agent output (the thing you're scoring)\n```\n{agent_output}\n```\n"
    )


def oracle_llm_judge(
    *,
    rubric: str,
    agent_output: str,
    reference_patch: str,
    gateway_url: str | None = None,
    model_alias: str | None = None,
    timeout_sec: float = 30.0,
    threshold: int = 3,
    fail_mode: str = "closed",
    _http_post: Any = None,  # injection seam for tests
) -> OracleResult:
    """LLM-as-judge oracle. Posts to llm-gateway's /v1/chat/completions
    (same shape as audit-gov's runJudge in llm-judge.ts) and parses
    the {score, reason} JSON out of the response.

    fail_mode:
      "closed" (default) — gateway error → oracle fails
      "open"             — gateway error → oracle passes (use when
                            LLM availability shouldn't gate the bench)
    """
    gw = (gateway_url or os.environ.get("LLM_GATEWAY_URL", "http://host.docker.internal:8001")).rstrip("/")
    model = model_alias or os.environ.get("JUDGE_MODEL_ALIAS") or ""
    body: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": _JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": _judge_user_prompt(rubric, agent_output, reference_patch)},
        ],
        "temperature": 0,
        "max_output_tokens": 400,
        "trace_id": "capability-harness-judge",
        # Previously untagged, so it would 400 under GATEWAY_REQUIRE_TASK_TAG.
        # "harness" over "judge" deliberately: both describe this call, but the
        # question an operator asks is "how much is the bench costing me",
        # and lumping bench spend in with production audit-gov judging is what
        # makes that question unanswerable. task_tags.py:37.
        "task_tag": "harness",
        # Bench tooling. No human is waiting on any individual judge call.
        "actor_id": "system:capability-harness",
        # No tenant_id: the harness runs against fixtures, outside any tenant.
    }
    if model:
        body["model_alias"] = model

    poster = _http_post or _default_http_post
    try:
        raw = poster(f"{gw}/v1/chat/completions", body, timeout_sec)
    except Exception as exc:  # noqa: BLE001 — gateway can fail in many shapes
        passed = fail_mode == "open"
        return OracleResult(
            name="llm_judge",
            passed=passed,
            score=0.0,
            reason=f"gateway unreachable: {exc} (fail_mode={fail_mode})",
            details={"fail_mode": fail_mode},
        )

    content = ""
    if isinstance(raw, dict):
        content = str(raw.get("content") or "")
    parsed = _extract_judge_json(content)
    if parsed is None:
        passed = fail_mode == "open"
        return OracleResult(
            name="llm_judge",
            passed=passed,
            score=0.0,
            reason=f"judge response not parseable as JSON (fail_mode={fail_mode})",
            details={"raw_content": content[:500], "fail_mode": fail_mode},
        )

    score_int = max(1, min(5, int(parsed.get("score", 0))))
    reason = str(parsed.get("reason") or "").strip() or f"judge returned score={score_int}"
    passed = score_int >= threshold
    return OracleResult(
        name="llm_judge",
        passed=passed,
        score=score_int / 5.0,
        reason=(
            f"judge passed (score={score_int} >= threshold={threshold}): {reason}"
            if passed
            else f"judge failed (score={score_int} < threshold={threshold}): {reason}"
        ),
        details={"raw_score": score_int, "threshold": threshold},
    )


def _default_http_post(url: str, body: dict[str, Any], timeout_sec: float) -> dict[str, Any]:
    """Standard-library HTTP POST. Kept tiny + dependency-free so the
    harness has no httpx/requests requirement — easier to run from
    `python -m` in any environment."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(  # noqa: S310 — known internal URL
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def _extract_judge_json(content: str) -> dict[str, Any] | None:
    """Pull the first balanced {...} block out of `content`. Tolerates
    chatty preambles and markdown fences — same forgiving pattern as
    audit-gov's runJudge."""
    if not content:
        return None
    match = re.search(r"\{[\s\S]*\}", content)
    if not match:
        return None
    try:
        result = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return result if isinstance(result, dict) else None


# ── Oracle 3: tests pass (Slice 2 — live) ───────────────────────────────────


def oracle_tests_pass(
    *,
    task_id: str,
    agent_output: str,
    test_code: str | None = None,
    test_timeout_sec: float | None = None,
    _sandbox: Any = None,  # injection seam for tests
    **_kwargs: Any,
) -> OracleResult:
    """Run the corpus's `test_code` against the agent's output in a
    subprocess sandbox (Slice 2). When the corpus task has no
    test_code, skip cleanly — the diff + judge oracles still vote.

    Wired in Slice 2 (#115). Earlier behavior (stub returning False)
    is preserved when test_code is absent, so tasks authored under
    Slice 1 don't regress.
    """
    if not test_code:
        return OracleResult(
            name="tests_pass",
            passed=False,
            score=0.0,
            reason="no test_code in corpus — oracle skipped (add test_code to enable)",
            details={"status": "skipped", "task_id": task_id},
        )
    if not agent_output:
        return OracleResult(
            name="tests_pass",
            passed=False,
            score=0.0,
            reason="agent produced no code to test",
            details={"status": "no_agent_output", "task_id": task_id},
        )

    # Lazy import — keeps the sandbox stdlib-import out of the
    # critical path for dry-runs that never need it.
    if _sandbox is None:
        from sandbox import run_python_tests as _sandbox  # type: ignore

    sb_result = _sandbox(
        agent_code=agent_output,
        test_code=test_code,
        timeout_sec=test_timeout_sec or 30.0,
    )
    return OracleResult(
        name="tests_pass",
        passed=sb_result.passed,
        score=1.0 if sb_result.passed else 0.0,
        reason=sb_result.reason,
        details={
            "exit_code": sb_result.exit_code,
            "duration_ms": sb_result.duration_ms,
            "timed_out": sb_result.timed_out,
            "stderr_tail": (sb_result.stderr or "")[-500:],
        },
    )


# ── Composite scoring ───────────────────────────────────────────────────────


def score_task(
    *,
    task: Any,                          # CorpusTask; loose-typed to avoid circular import
    agent_output: str,
    judge_gateway_url: str | None = None,
    judge_model_alias: str | None = None,
    skip_judge: bool = False,
    threshold_majority: int = 2,
) -> TaskScore:
    """Run all three oracles and combine. Pass when at least
    `threshold_majority` oracles vote pass (default 2 of 3 = majority).

    skip_judge=True bypasses the LLM call — used in dry-run mode and
    in unit tests where we don't want a network round-trip."""
    oracles: list[OracleResult] = []

    oracles.append(oracle_diff_matches_reference(
        agent_output=agent_output,
        reference_patch=task.reference_patch,
    ))

    if skip_judge:
        oracles.append(OracleResult(
            name="llm_judge",
            passed=False,
            score=0.0,
            reason="skipped (dry-run / explicit skip)",
            details={"skipped": True},
        ))
    else:
        oracles.append(oracle_llm_judge(
            rubric=task.rubric,
            agent_output=agent_output,
            reference_patch=task.reference_patch,
            gateway_url=judge_gateway_url,
            model_alias=judge_model_alias,
        ))

    oracles.append(oracle_tests_pass(
        task_id=task.task_id,
        agent_output=agent_output,
        test_code=getattr(task, "test_code", None),
        test_timeout_sec=getattr(task, "test_timeout_sec", None),
    ))

    pass_votes = sum(1 for o in oracles if o.passed)
    return TaskScore(
        task_id=task.task_id,
        passed=pass_votes >= threshold_majority,
        oracles=oracles,
    )
