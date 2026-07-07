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
import logging
import os
import re
from typing import Any

import httpx

from ..iam_service_token import get_iam_service_token
from .code_context import build_code_context_for_governed_turn, package_markdown
from .dispatch import ToolDispatchError, dispatch_tool
from .phase_state import Phase, PhaseState
from .placement import mcp_laptop_target, runtime_capability_tags, runtime_tenant_target
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
    raw_artifacts = data.get("artifacts") or []
    artifacts = [
        {"path": str(a.get("path") or ""), "content": str(a.get("content") or "")}
        for a in raw_artifacts if isinstance(a, dict) and a.get("path")
    ]
    return {
        "summary": str(data.get("summary") or ""),
        "diff": str(data.get("diff") or ""),
        "changed_paths": [str(p) for p in changed],
        "artifacts": artifacts,
        "commit_sha": data.get("commitSha") or data.get("commit_sha"),
        "duration_ms": data.get("duration_ms"),
    }


def _work_item_description(vars: dict[str, Any] | None) -> str:
    """Best-effort: the work item's description from the run vars."""
    v = vars or {}
    for key in ("workItemDetails", "_workItem", "workItem"):
        wi = v.get(key)
        if isinstance(wi, dict):
            desc = wi.get("description") or wi.get("title")
            if isinstance(desc, str) and desc.strip():
                return desc.strip()
    desc = v.get("description")
    return desc.strip() if isinstance(desc, str) else ""


def _agent_runtime_base() -> str:
    base = os.environ.get("AGENT_RUNTIME_URL", "").rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/api/v1") else f"{base}/api/v1"


def _render_distilled_world_model(wm: dict[str, Any], artifacts: list[dict[str, Any]]) -> str | None:
    """Render the distilled CapabilityWorldModel (+ top artifact names) as a compact
    markdown block — the fallback grounding when the live code-context build is
    unavailable. Defensive about the exact field shape."""
    lines: list[str] = []
    lang = wm.get("primaryLanguage")
    build = wm.get("buildSystem")
    stack = " / ".join(str(x) for x in (lang, build) if x)
    if stack:
        lines.append(f"- **Stack:** {stack}")
    readme = str(wm.get("readmeSummary") or "").strip()
    if readme:
        lines.append(f"- **Overview:** {readme[:1200]}")
    entry = wm.get("entrypoints")
    if isinstance(entry, list) and entry:
        lines.append("- **Entry points:** " + ", ".join(str(e) for e in entry[:8]))
    conv = wm.get("codeConventions")
    if isinstance(conv, list) and conv:
        lines.append("- **Conventions:** " + "; ".join(str(c) for c in conv[:6]))
    names = [str(a.get("name") or a.get("title") or a.get("path") or "").strip() for a in artifacts]
    names = [n for n in names if n]
    if names:
        lines.append("- **Knowledge artifacts:** " + ", ".join(names[:8]))
    text = "\n".join(lines).strip()
    return text or None


async def _fetch_distilled_world_model(capability_id: str, bearer: str | None) -> str | None:
    """Fallback grounding: fetch the capability's DISTILLED world model + top
    knowledge artifacts from agent-runtime and render markdown. Best-effort — returns
    None on any error so the prompt still composes."""
    base = _agent_runtime_base()
    if not base or not capability_id:
        return None
    token = bearer or (await get_iam_service_token())
    headers = {"authorization": f"Bearer {token or ''}"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            wm_resp = await client.get(f"{base}/capabilities/{capability_id}/world-model", headers=headers)
            if wm_resp.status_code != 200:
                return None
            wm_body = wm_resp.json()
            wm = wm_body.get("data") if isinstance(wm_body, dict) else None
            if not isinstance(wm, dict):
                return None
            artifacts: list[dict[str, Any]] = []
            try:
                a_resp = await client.get(f"{base}/capabilities/{capability_id}/knowledge-artifacts", headers=headers)
                if a_resp.status_code == 200:
                    a_body = a_resp.json()
                    data: Any = a_body.get("data") if isinstance(a_body, dict) else a_body
                    if isinstance(data, dict):
                        data = data.get("items") or data.get("artifacts") or []
                    if isinstance(data, list):
                        artifacts = [x for x in data if isinstance(x, dict)]
            except Exception:  # noqa: BLE001 — artifacts are optional
                artifacts = []
    except Exception:  # noqa: BLE001 — best-effort fallback
        return None
    return _render_distilled_world_model(wm, artifacts)


def _fenced(content: str, lang: str = "markdown") -> str:
    """Fence a block, bounded so a big upstream doc can't blow up the prompt."""
    body = content.strip()
    if len(body) > 8000:
        body = body[:8000].rstrip() + "\n\n… (truncated — open the file for the full document)"
    return f"```{lang}\n{body}\n```"


def _artifact_line(a: dict[str, Any], *, verb: str, vars: dict[str, Any] | None) -> str:
    """One bullet for an artifact def: name (format) — <verb> `path` — description.
    Prefers the real file `path` over the logical `bindingPath`, and interpolates
    {{instance.vars.*}} in it so the agent gets the concrete path."""
    name = str(a.get("name") or a.get("id") or "document").strip()
    fmt = str(a.get("format") or "").strip()
    raw_path = str(a.get("path") or a.get("bindingPath") or "").strip()
    path = interpolate_task(raw_path, vars or {}) if raw_path else ""
    desc = str(a.get("description") or "").strip()
    bits = [f"- **{name}**"]
    if fmt:
        bits.append(f"({fmt})")
    if path:
        bits.append(f"— {verb} `{path}`")
    if a.get("required") is False:
        bits.append("_(optional)_")
    line = " ".join(bits)
    if desc:
        line += f" — {desc}"
    return line


def _render_artifact_contract(run_context: dict[str, Any] | None, vars: dict[str, Any] | None) -> list[str]:
    """Render the stage's IN/OUT document contract as prompt sections. For inputs:
    the real path + the upstream document's CONTENT inlined when available (so the
    stage is self-contained even if the world model / repo read is unavailable). For
    outputs: the real save path + a MARKDOWN template to follow. Empty when the node
    declares no artifacts."""
    rc = run_context or {}
    parts: list[str] = []

    inputs = rc.get("input_artifacts")
    if isinstance(inputs, list) and inputs:
        blocks: list[str] = []
        for a in inputs:
            if not isinstance(a, dict):
                continue
            blocks.append(_artifact_line(a, verb="read", vars=vars))
            content = a.get("content")
            if isinstance(content, str) and content.strip():
                blocks.append(_fenced(content))
        if blocks:
            parts.append(
                "## Input documents (read these first)\n"
                "These were produced by upstream stages of this workflow — they are the inputs to "
                "your work. When a document's content is included below, use it directly; otherwise "
                "open the file at the given path in the repository.\n"
                + "\n".join(blocks)
            )

    outputs = rc.get("output_artifacts")
    if isinstance(outputs, list) and outputs:
        blocks: list[str] = []
        for a in outputs:
            if not isinstance(a, dict):
                continue
            blocks.append(_artifact_line(a, verb="save as", vars=vars))
            template = a.get("template")
            if isinstance(template, str) and template.strip():
                blocks.append("Follow this template:\n" + _fenced(template))
        if blocks:
            parts.append(
                "## Documents to produce\n"
                "Produce each of these as a real file in the repository, in the stated format. Where "
                "a template is given, follow its structure.\n"
                + "\n".join(blocks)
            )
    return parts


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
    """Compose a COPILOT-appropriate prompt.

    Copilot is the CLI agent — it works DIRECTLY on files. So this is NOT the
    workbench/governed-loop prompt (which tells the agent to use MCP AST tools and
    emit governed consumables / gate recommendations). We give Copilot: the role,
    the work item description, the task, and the repo world model, with plain
    "edit the files yourself" instructions. Best-effort: the world model is
    optional (mcp/index may be unavailable).
    """
    # Runtime prompt override (run-graph Prompt tab "Edit prompt"): the operator edited
    # the fully-composed prompt, so use it VERBATIM and skip composition — it already
    # carries the role, work item, and world model they saw on screen.
    override = (run_context or {}).get("prompt_override")
    if isinstance(override, str) and override.strip():
        return override.strip()
    code_md = ""
    world_model_reason: str | None = None
    try:
        # Mirror the governed loop (turn.py): do NOT pass mcp_base_url. Transport
        # is placement-driven — when this run is on the user's laptop the builder
        # dispatches over the code-context bridge frame (the repo/worktree is on
        # the laptop); otherwise it POSTs the static MCP_SERVER_URL. Forcing the
        # env var here is what previously left the world model empty.
        pkg, world_model_reason = await build_code_context_for_governed_turn(
            task_text=resolved_task,
            capability_id=capability_id,
            run_context=run_context,
            laptop_user_id=mcp_laptop_target(run_context),
            runtime_tenant_id=runtime_tenant_target(run_context),
            runtime_capability_tags=runtime_capability_tags(run_context),
        )
        if pkg:
            code_md = package_markdown(pkg) or ""
            if not code_md.strip():
                world_model_reason = world_model_reason or "code_context.skipped: package produced empty markdown"
    except Exception as exc:  # noqa: BLE001 — best-effort; the world model is optional
        code_md = ""
        world_model_reason = f"code_context exception: {exc}"

    description = _work_item_description(vars)
    role = (agent_role or "").strip()

    parts: list[str] = [
        "You are working DIRECTLY in a Git repository already cloned to your current working "
        "directory. Read and edit the files yourself, run commands as needed, and SAVE any "
        "documents you produce (e.g. REQUIREMENTS.md, DESIGN.md) as real files in the repo. Make "
        "the actual changes — do not just describe them. Be concise.",
    ]
    if role:
        parts.append(f"You are acting as the **{role}** for this stage of the SDLC.")
    if description and description != resolved_task.strip():
        parts.append(f"## Work item\n{description}")
    parts.append(f"## Your task\n{resolved_task.strip()}")
    if code_md.strip():
        parts.append(f"## Repository world model (code context)\n{code_md.strip()}")
    else:
        # Live code-context build unavailable → fall back to the capability's DISTILLED
        # world model (stack + README + key artifacts) so the prompt is STILL grounded
        # even when the laptop code-context bridge isn't serving a live index. Only if
        # that's also empty do we surface the diagnostic (logs + inline) instead of
        # silently dropping the section.
        fallback_md = await _fetch_distilled_world_model(capability_id, bearer) if capability_id else None
        if fallback_md:
            parts.append(f"## Repository world model (capability knowledge)\n{fallback_md}")
        elif world_model_reason:
            logging.getLogger("context_api.compose_copilot").warning(
                "no repo world model (stage=%s capability=%s): %s",
                stage_key, capability_id, world_model_reason,
            )
            parts.append(
                "## Repository world model (code context)\n"
                "_Unavailable for this run — read the repository files directly to build your context._\n"
                f"_diagnostic: {world_model_reason}_"
            )
    # Stage IN/OUT document contract — the documents this stage READS (inputs, with
    # their repo paths) and must PRODUCE (outputs, with format). Empty when the node
    # declares no artifacts, so non-SDLC prompts are unchanged.
    parts.extend(_render_artifact_contract(run_context, vars))
    # Clarifying-questions protocol. When Copilot has to assume something to
    # proceed (most common in the requirements stage), it lists the open
    # questions in a `## Questions` block at the END of its reply. mcp-server's
    # summary carries that block back; the run view parses it, renders the
    # questions, and re-runs this stage with the operator's answers injected.
    parts.append(
        "## If you need clarification\n"
        "If anything is ambiguous, or you had to assume something to proceed, add a "
        "section titled `## Questions` at the VERY END of your reply — one `-` bullet "
        "per question. For a multiple-choice question, list the options after pipes, e.g. "
        "`Which datastore should we use? | Postgres | DynamoDB | not sure`. "
        "Still do your best on the deliverable now; the questions just let a human "
        "confirm your assumptions and re-run this stage with their answers. "
        "Omit the section entirely if you have no questions."
    )
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
            "artifacts": parsed["artifacts"],
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
