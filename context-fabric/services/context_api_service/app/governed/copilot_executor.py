"""§13.4 — server-orchestrated Copilot execution (CF dispatches, mcp invokes).

When a phase is marked ``run_context.executor == "copilot"``, context-fabric does
NOT run the function-calling loop (``run_stage``) — the GitHub Copilot CLI is an
agent that returns TEXT, not OpenAI ``tool_calls``, so there is no loop to drive.
Instead CF dispatches the ``copilot_execute`` tool to mcp-server via the normal
``dispatch_tool`` path. With ``laptop_user_id`` set, that routes to the USER'S
LAPTOP mcp-server (the existing per-user bridge), which runs
``copilot -p "<task>" --allow-all`` inside the already-materialized work-item
workspace and returns ``{summary, changedPaths, diff}``. We wrap that receipt as a
FINALIZED :class:`StageRunResult` — the same shape ``run_stage`` returns — so every
downstream consumer (workgraph AGENT_TASK, the workbench) is unchanged.

This is the "mcp invokes Copilot, CF orchestrates" model: governance + audit flow
through the existing tool-run path; Copilot runs where the workspace + the user's
Copilot auth already are.
"""
from __future__ import annotations

import dataclasses
import os
import re
from typing import Any

from .code_context import build_code_context_for_governed_turn, package_markdown
from .dispatch import ToolDispatchError, dispatch_tool
from .phase_state import Phase, PhaseState
from .prompt_resolver import resolve_phase_prompt
from .stage_driver import StageRunResult

_VAR_RE = re.compile(r"\{\{\s*instance\.vars\.([\w]+)\s*\}\}")


def interpolate_task(task: str, vars: dict[str, Any] | None) -> str:
    """Substitute {{instance.vars.X}} in the phase task with req.vars[X].

    The governed-stage route doesn't interpolate run_context.task (only the
    legacy /execute path interpolates its top-level task), so the copilot phase
    task arrives raw — do it here against the stage vars before handing it to
    the CLI.
    """
    v = vars or {}
    return _VAR_RE.sub(lambda m: str(v.get(m.group(1), "")), task or "")


def parse_copilot_result(result: Any) -> dict[str, Any]:
    """Extract ``{summary, diff, changed_paths, duration_ms}`` from a
    ``copilot_execute`` tool result. Defensive about output nesting: the
    tool-run ``result`` is the handler's ``output`` object, but tolerate a
    further ``output`` wrapper and snake/camel ``changedPaths`` just in case.
    """
    data = result if isinstance(result, dict) else {}
    if not data.get("summary") and isinstance(data.get("output"), dict):
        data = data["output"]
    changed = data.get("changedPaths") or data.get("changed_paths") or []
    return {
        "summary": str(data.get("summary") or ""),
        "diff": str(data.get("diff") or ""),
        "changed_paths": [str(p) for p in changed],
        "commit_sha": data.get("commitSha") or data.get("commit_sha"),
        "duration_ms": data.get("duration_ms"),
    }


async def compose_copilot_prompt(
    *,
    stage_key: str | None,
    agent_role: str | None,
    capability_id: str | None,
    resolved_task: str,
    vars: dict[str, Any] | None,
    run_context: dict[str, Any] | None,
    bearer: str | None,
) -> str:
    """Compose the FULL prompt for Copilot the SAME way the governed loop does:
    the agent-role / stage prompt (prompt-composer) + the repo world model (the
    code-context package) + the task. Best-effort — falls back to the raw task on
    any failure so a missing prompt binding never blocks the stage.
    """
    if not stage_key:
        return resolved_task
    # 1. Repo world model — the same code-context package the governed loop builds.
    code_md = ""
    try:
        pkg, _reason = await build_code_context_for_governed_turn(
            task_text=resolved_task,
            capability_id=capability_id,
            run_context=run_context,
            mcp_base_url=os.environ.get("MCP_SERVER_URL"),
            mcp_bearer=os.environ.get("MCP_BEARER_TOKEN"),
        )
        if pkg:
            code_md = package_markdown(pkg) or ""
    except Exception:
        code_md = ""
    # 2. Resolve the agent-role / stage prompt via prompt-composer, with the world
    #    model available to its {{code_context_package}} template var.
    compose_vars: dict[str, Any] = {**(vars or {}), "goal": resolved_task, "task": resolved_task}
    if code_md:
        compose_vars["code_context_package"] = code_md
    try:
        resolved = await resolve_phase_prompt(
            stage_key=stage_key,
            agent_role=agent_role,
            phase=None,
            vars=compose_vars,
            bearer=bearer,
        )
    except Exception:
        # No binding / composer down → raw task, plus the world model if we have it.
        return f"{resolved_task}\n\n## Repository context\n{code_md}".strip() if code_md else resolved_task

    parts: list[str] = []
    if resolved.system_prompt_append.strip():
        parts.append(resolved.system_prompt_append.strip())
    body = resolved.task
    if resolved.extra_context.strip():
        body = f"{body}\n\n{resolved.extra_context}"
    parts.append(body)
    # If the resolved prompt didn't already embed the world model (template lacked
    # {{code_context_package}}), append it so Copilot always has the repo context.
    if code_md and code_md[:80] not in (resolved.system_prompt_append + resolved.task):
        parts.append(f"## Repository context\n{code_md}")
    return "\n\n".join(p for p in parts if p.strip()).strip() or resolved_task


async def run_stage_via_copilot(
    state: PhaseState,
    *,
    task: str,
    vars: dict[str, Any] | None = None,
    stage_key: str | None = None,
    agent_role: str | None = None,
    capability_id: str | None = None,
    work_item_id: str | None,
    run_context: dict[str, Any] | None,
    laptop_user_id: str | None = None,
    bearer: str | None = None,
) -> StageRunResult:
    """Dispatch ``copilot_execute`` to mcp-server and wrap the receipt as a
    FINALIZED stage result. Failures surface as an ``LLM_ERROR`` stop_reason so
    the caller handles them like any other stage failure.
    """
    resolved_task = interpolate_task(task, vars)
    # Compose the full prompt (agent role + repo world model + task) via the same
    # prompt-composer route the governed loop uses, instead of the raw task.
    prompt_for_copilot = await compose_copilot_prompt(
        stage_key=stage_key,
        agent_role=agent_role,
        capability_id=capability_id,
        resolved_task=resolved_task,
        vars=vars,
        run_context=run_context,
        bearer=bearer,
    )
    try:
        disp = await dispatch_tool(
            "copilot_execute",
            {"task": prompt_for_copilot},
            work_item_id=work_item_id,
            run_context=run_context,
            bearer=bearer,
            laptop_user_id=laptop_user_id,
        )
    except ToolDispatchError as exc:
        return StageRunResult(
            final_state=state,
            stop_reason="LLM_ERROR",
            error_code="COPILOT_DISPATCH_FAILED",
            error_message=str(exc),
        )

    if not disp.tool_success:
        return StageRunResult(
            final_state=state,
            stop_reason="LLM_ERROR",
            error_code="COPILOT_EXECUTE_FAILED",
            error_message=disp.tool_error or "copilot_execute returned success=false",
        )

    parsed = parse_copilot_result(disp.result)

    # PhaseState is a frozen dataclass, so we can't assign to its fields — build a
    # new terminal state with dataclasses.replace, copying the mutable containers
    # so the caller's state isn't touched. The Copilot CLI did the whole phase, so
    # we land directly in FINALIZE with the receipt as evidence.
    receipts = {k: list(v) for k, v in state.receipts.items()}
    receipts.setdefault(Phase.FINALIZE.value, []).append(
        {
            "kind": "copilot_execution",
            "executor": "copilot-cli",
            "prompt": prompt_for_copilot,
            "summary": parsed["summary"],
            "changed_paths": parsed["changed_paths"],
            "diff": parsed["diff"],
            "commitSha": parsed["commit_sha"],
            "served_by": disp.served_by,
        }
    )
    produced = dict(state.produced_code_changes)
    if parsed["changed_paths"]:
        produced[Phase.FINALIZE.value] = parsed["changed_paths"]
    history = list(state.history) + [{"role": "assistant", "content": parsed["summary"]}]
    final_state = dataclasses.replace(
        state,
        current_phase=Phase.FINALIZE,
        receipts=receipts,
        produced_code_changes=produced,
        history=history,
    )

    return StageRunResult(
        final_state=final_state,
        stop_reason="FINALIZED",
        turns=[
            {
                "role": "assistant",
                "content": parsed["summary"],
                "executor": "copilot-cli",
                "changed_paths": parsed["changed_paths"],
                "served_by": disp.served_by,
            }
        ],
        total_tool_calls=1,
    )
