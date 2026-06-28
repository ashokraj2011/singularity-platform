"""
M71 Slice C(b) — Single-turn LLM driver.

Wires the resolved per-phase prompt, the LLM gateway, and the governance
oracle (`loop.governed_step`) into ONE round trip:

    workgraph-api / Workbench
        │
        v
    POST /api/v1/execute-governed-turn
        │
        v  context-fabric
        │   1. load StagePolicy
        │   2. resolve per-phase prompt (prompt-composer)
        │   3. build LLM messages + tool descriptors
        │   4. POST llm-gateway /v1/chat/completions
        │   5. parse tool_calls + extract submit_phase_output meta-call
        │   6. governed_step() — hard-refuse, dispatch, validate, advance
        │   7. return {next_state, llm_response_meta, step_result}
        │
        v
    caller persists next_state, decides whether to call again

The LLM signals phase completion by invoking a synthetic meta-tool called
`submit_phase_output` with `{payload, next_phase}` arguments. The turn
loop intercepts it (it never reaches mcp-server) and routes the payload
through the receipt validator + state machine. Every other tool call goes
through the policy gateway and onto /mcp/tool-run as usual.

This is the SINGLE-TURN form. Multi-turn (keep calling until phase
advances or we hit max_turns) is C(b2) — sketched out in `run_phase()`
below but not exposed via HTTP yet.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from typing import Any

# M90.D (2026-05-27) — thinking-block audit capture gate. Default OFF.
# Set AUDIT_CAPTURE_THINKING=true on the context-api container to
# include thinking_blocks content in the governed.llm_response audit
# payload (their counts + token totals are still emitted regardless).
# Default-off because thinking content is the model's internal chain
# of thought — useful for debugging but verbose, and Anthropic asks
# that it not be persisted to user-facing surfaces. Operators who
# need it for development can opt in via env.
_AUDIT_CAPTURE_THINKING = os.environ.get("AUDIT_CAPTURE_THINKING", "").lower() in (
    "1", "true", "yes", "on",
)

# (2026-05-31) — full-prompt audit capture gate. Default ON.
# When enabled, the governed.llm_request event carries the COMPLETE composed
# message array (system + user + tool-result history) sent to the LLM that
# turn, so operators see the entire prompt per phase in the Workbench loop
# trace. Uncapped by operator choice. Disable with CF_CAPTURE_FULL_PROMPT=false
# if audit-store size becomes a concern (prompts include repo code/snippets).
_CAPTURE_FULL_PROMPT = os.environ.get("CF_CAPTURE_FULL_PROMPT", "true").lower() in (
    "1", "true", "yes", "on",
)

# (code-context E2) — prompt-capture hardening. Capture stays ON by default
# (operators rely on the Workbench "Full prompt sent" panel), but the captured
# copy is now CAPPED + secret-MASKED before it lands in the audit store: per-
# message content is clipped so a giant repo-context prompt can't bloat the
# ledger, and obvious secrets (bearer tokens, API keys) are redacted. The actual
# prompt sent to the gateway is untouched. Tune the cap with
# CF_PROMPT_CAPTURE_MAX_CHARS.
_PROMPT_CAPTURE_MAX_CHARS = int(os.environ.get("CF_PROMPT_CAPTURE_MAX_CHARS", "200000"))

# (pattern, replacement) secret masks. Conservative — target high-signal token
# shapes, NOT broad base64 (which would clobber legitimate code in slices).
_SECRET_MASKS = [
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{12,}"), r"\1 «redacted»"),
    (re.compile(r"(?i)(authorization\"?\s*[:=]\s*\"?)(?:bearer\s+)?[A-Za-z0-9._\-]{12,}"), r"\1«redacted»"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"), "«redacted-key»"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "«redacted-token»"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "«redacted-aws-key»"),
    (re.compile(r"(?i)(\"?(?:api[_-]?key|secret|password|token)\"?\s*[:=]\s*\"?)[^\s\"',]{8,}"), r"\1«redacted»"),
]


def _mask_secrets(text: str) -> str:
    if not text:
        return text
    for pattern, repl in _SECRET_MASKS:
        text = pattern.sub(repl, text)
    return text


def _sanitize_captured_messages(messages: list[dict]) -> list[dict]:
    """Return a capture-safe copy of the composed messages for the audit event.

    Never mutates the originals (those still go to the gateway verbatim). Masks
    secret-like tokens and clips each message's content so the total stays
    roughly within CF_PROMPT_CAPTURE_MAX_CHARS.
    """
    n = max(1, len(messages))
    per_msg = max(2000, _PROMPT_CAPTURE_MAX_CHARS // n)
    out: list[dict] = []
    for m in messages:
        if not isinstance(m, dict):
            out.append(m)
            continue
        safe = dict(m)
        content = safe.get("content")
        if isinstance(content, str):
            content = _mask_secrets(content)
            if len(content) > per_msg:
                content = content[:per_msg] + f"\n…[truncated {len(content) - per_msg} chars]"
            safe["content"] = content
        out.append(safe)
    return out

from .audit_emit import emit_governed_event
from . import placement as _placement
from .llm_client import ChatResponse, ChatToolCall, LLMGatewayError, call_gateway_chat
from .code_context import (
    build_code_context_for_governed_turn,
    package_markdown,
)
from .effective_capabilities import (
    effective_capabilities_from_context,
    effective_capabilities_required,
    effective_capabilities_required_but_empty,
)
from .model_catalog import context_window_for
from .loop import GovernedStepResult, governed_step
from .phase_state import Phase, PhaseState
from .policy_loader import PolicyNotFoundError, StagePolicy, load_stage_policy
from .prompt_safety import safen_history
from .prompt_resolver import (
    PromptNotFoundError,
    ResolvedPrompt,
    resolve_phase_prompt,
)
from .stage_execution_policy import StageExecutionPolicy, apply_execution_policy
from .tool_gateway import allowed_tools_for
from .tool_schemas import schema_for_tool
from ..execute_modules.tool_policy import filter_tools_by_effective_capabilities

log = logging.getLogger(__name__)


def _render_policy_facts(
    ctx_policy: dict[str, Any], vars: dict[str, Any]
) -> str:
    """M99 S3.2 — render resolved policy facts (+ localization summary) into
    one compact markdown block for `{{policy_facts}}` in a prompt template.

    Replaces scattered static per-phase prose with the ACTUAL resolved values
    for this stage. Returns "" when there are no facts worth stating, so a
    template that references the var renders nothing rather than an empty
    header. Pure + side-effect-free; safe to call every turn.
    """
    lines: list[str] = []
    if ctx_policy.get("ast_first"):
        lines.append(
            "- Prefer AST tools (find_symbol / get_ast_slice) over full-file "
            "reads; read whole files only when a slice genuinely won't do."
        )
    thr = ctx_policy.get("large_file_threshold_lines")
    if isinstance(thr, int) and thr > 0:
        if ctx_policy.get("full_file_read_requires_justification"):
            lines.append(
                f"- Reads over {thr} lines are REFUSED unless you pass a "
                "`justification` argument explaining why a targeted slice "
                "won't work."
            )
        else:
            lines.append(
                f"- Reads over {thr} lines are flagged; keep reads focused."
            )
    if ctx_policy.get("require_context_receipt"):
        lines.append(
            "- EXPLORE must produce a substantive ContextReceipt (≥1 "
            "context_used entry or implementation_finding) before advancing."
        )
    # Localization summary (S1.1) — only present when the platform localized.
    loc_summary = vars.get("localization_summary")
    if isinstance(loc_summary, str) and loc_summary.strip():
        lines.append(f"- Localization: {loc_summary.strip()}")
    if not lines:
        return ""
    return "## Policy & context facts for this stage\n" + "\n".join(lines)


# Synthetic meta-tool the LLM calls to submit its phase output + declare
# the next phase. NEVER dispatched to mcp-server. The loop catches the call
# by name and routes the payload through the receipt validator.
SUBMIT_PHASE_OUTPUT = "submit_phase_output"


@dataclass
class TurnResult:
    """One LLM turn's outcome. Returned by `/api/v1/execute-governed-turn`."""

    # Phase state after the turn — caller persists this.
    next_state: PhaseState
    # Governance-oracle result (tool outcomes, validation errors, etc.).
    step: GovernedStepResult
    # LLM response meta (no token-by-token content; just usage + finish_reason).
    llm: dict[str, Any]
    # Which prompt binding fired (binding_id + phase_used). Operators rely
    # on this to debug "why did the agent get the wrong instructions".
    prompt: dict[str, Any]
    # Resolved policy summary so the caller doesn't have to fetch it separately.
    policy: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "next_state": self.next_state.to_dict(),
            "step": self.step.to_dict(),
            "llm": self.llm,
            "prompt": self.prompt,
            "policy": self.policy,
        }


def _build_messages(prompt: ResolvedPrompt, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compose the OpenAI-style message list the gateway expects.

    System message = prompt.system_prompt_append.
    User message   = prompt.task + (extra_context if any).
    History       = optional list of prior {role, content, tool_calls, tool_call_id}
                    entries from earlier turns this phase. Empty on the first turn.

    M74 Phase 3B — tool-role messages in history are wrapped in
    `<tool_result>...</tool_result>` delimiters via safen_history before
    they reach the model. This defends against the basic
    prompt-injection-via-tool-output attack class (a fetched README
    containing "Ignore previous instructions" no longer parses as a
    command to the model). The wrap is applied here, not at history
    accumulation time, so stage_driver's bookkeeping (compression,
    persistence) operates on the un-wrapped messages.
    """
    messages: list[dict[str, Any]] = []
    if prompt.system_prompt_append.strip():
        messages.append({"role": "system", "content": prompt.system_prompt_append})
    body = prompt.task
    if prompt.extra_context.strip():
        body = f"{body}\n\n{prompt.extra_context}"
    if body:
        messages.append({"role": "user", "content": body})
    messages.extend(safen_history(history))
    return messages


def _build_tool_descriptors(
    policy: StagePolicy,
    phase: Phase,
    blocked: set[str] | None = None,
    effective_capabilities: list[dict[str, Any]] | None = None,
    require_effective_capabilities: bool = False,
) -> list[dict[str, Any]]:
    """Tool descriptors handed to the LLM.

    M72 Slice A — Cache-stable variant. The descriptor list is now the UNION
    of every tool across all phases of the stage's StagePolicy. Each tool
    carries a `phase_scope` hint in its description so the LLM can avoid
    out-of-phase calls without us having to filter the tool list per turn.
    The hard-refuse path (`tool_gateway.check_tool_allowed`) still catches
    any actual out-of-phase dispatch server-side — we just stop invalidating
    the LLM-provider prompt-cache prefix every time we transition phases.

    Before M72A: phase transitions changed the tools[] block →
                 Anthropic/OpenAI prompt-cache prefix invalidated →
                 every phase boundary paid a full re-ingestion cost.
    After M72A:  tools[] stable across the whole stage →
                 cache prefix persists through PLAN→EXPLORE→ACT→…→FINALIZE →
                 cost-per-turn drops materially on cache-aware providers.

    The synthetic `submit_phase_output` meta-tool is appended last, exactly
    as before — calling it advances the phase machine.
    """
    # Build the union of allowed tools across every phase row in the policy,
    # subtracting any that the phase explicitly forbids. Sorted for stable
    # ordering (cache hashes care about list order on some providers).
    union: dict[str, set[str]] = {}  # tool_name → set of phases it's allowed in
    for phase_policy in policy.phases.values():
        deny = phase_policy.forbidden_tools
        for tool_name in phase_policy.allowed_tools:
            if tool_name in deny:
                continue
            # G4 governance overlay: drop overlay-blocked tools from the LLM's
            # tool list entirely (the dispatch-side hard refuse in governed_step
            # is the backstop if the model emits one anyway).
            if blocked and tool_name in blocked:
                continue
            union.setdefault(tool_name, set()).add(phase_policy.phase.value)

    descriptors: list[dict[str, Any]] = []
    for tool_name in sorted(union.keys()):
        scopes = sorted(union[tool_name])
        # M90.E (2026-05-27) — real per-tool input_schema from
        # tool_schemas.py, falling back to {type: "object"} for any
        # tool not in the registry. Pre-M90.E every tool got the bare
        # fallback, causing the LLM to emit wrong arg names and burn
        # turns on schema-shape errors. The registry is module-constant
        # → still byte-stable across the stage → M72A cache-stability
        # contract preserved.
        descriptors.append({
            "name": tool_name,
            # Scope hint lives in the description so cache stays stable —
            # changing the description per phase would also invalidate the
            # cache. We embed ALL scopes here; the LLM reads them to know
            # when this tool is callable. Server-side enforcement is the
            # real gate. Keeping the descriptor strictly to `{name,
            # description, input_schema}` so Anthropic/OpenAI/Gemini schema
            # validators accept it unchanged.
            "description": (
                f"MCP tool '{tool_name}'. Phase scope: {', '.join(scopes)}. "
                f"Calling it outside its scope returns PHASE_TOOL_FORBIDDEN; "
                f"choose a tool whose scope includes the current phase."
            ),
            "input_schema": schema_for_tool(tool_name),
        })
    descriptors, _warnings = filter_tools_by_effective_capabilities(
        descriptors,
        effective_capabilities or [],
        require_effective_capabilities=require_effective_capabilities,
    )
    # The meta-tool. The phase output schema lives in the prompt; we don't
    # try to mirror it as JSON Schema here (too many phase-specific shapes
    # to keep in sync). The validator catches any malformed payload.
    descriptors.append({
        "name": SUBMIT_PHASE_OUTPUT,
        "description": (
            "Submit the structured output for this phase and advance to the next phase. "
            "Call this when you have produced the receipt described in your prompt. "
            "Arguments: {payload: <phase-receipt object>, next_phase: <PHASE NAME>}."
        ),
        "input_schema": {
            "type": "object",
            "required": ["payload"],
            "properties": {
                "payload": {"type": "object", "description": "The phase receipt."},
                "next_phase": {
                    "type": "string",
                    "description": "Where to advance after validation. Omit to stay in current phase.",
                },
            },
        },
    })
    return descriptors


@dataclass(frozen=True)
class _MalformedSubmit:
    """Captures a submit_phase_output call we couldn't extract a valid
    receipt from. Surfaces to the caller (run_turn) so we can:

      1. Emit a `governed.submit_phase_output_malformed` audit event
         (previously silent — see code-review fix 2026-05-24).
      2. Feed a structured error back to the LLM via stage_driver's
         validation-error injection path so the next turn knows what
         went wrong.

    `reason` is the operator-readable explanation; `arg_keys` and
    `payload_type` give the structured detail the LLM needs to self-
    correct without us leaking arbitrary user data.
    """

    reason: str
    arg_keys: list[str]
    payload_type: str
    next_phase_raw: str | None


def _extract_phase_output(
    tool_calls: list[ChatToolCall],
) -> tuple[dict[str, Any] | None, Phase | None, list[ChatToolCall], _MalformedSubmit | None]:
    """Split a turn's tool calls into (phase_output, next_phase, other_calls, malformed).

    If the LLM called `submit_phase_output`:
      - Pull its `payload` (dict). When the provider stringified the payload
        (some models JSON-encode the inner value of tool args even when the
        outer arguments object is already an object), JSON-decode it.
      - Pull its `next_phase` (string → Phase enum, or None).
      - Remove it from the tool_calls list returned for dispatch.

    When the call exists but produces NO usable phase_output, return a
    `_MalformedSubmit` so the caller can:
      - emit an audit event (otherwise this looks like a no-op turn from
        outside the loop), and
      - feed a corrective error message back into the next turn (otherwise
        the LLM blindly repeats the same mistake until the stagnant-turn
        guard fires).

    Multiple `submit_phase_output` calls in one turn: the LAST valid one
    wins. If none is valid, the LAST attempt drives the malformed report
    so the LLM sees feedback on its most recent shape (the one it'd retry).
    """
    phase_output: dict[str, Any] | None = None
    next_phase: Phase | None = None
    other_calls: list[ChatToolCall] = []
    last_malformed: _MalformedSubmit | None = None
    for call in tool_calls:
        if call.name != SUBMIT_PHASE_OUTPUT:
            other_calls.append(call)
            continue
        args = call.arguments or {}
        payload_raw = args.get("payload")
        # Some providers return arguments where the inner `payload` is
        # still a JSON-encoded string even though llm_client.from_dict
        # already parsed the OUTER arguments object. One more decode
        # attempt before giving up. We also accept the case where the
        # whole arguments object IS the payload (`{story_brief: ..., ...}`
        # without a `payload` wrapper) since smaller models routinely
        # collapse the wrapper.
        payload: dict[str, Any] | None = None
        if isinstance(payload_raw, dict):
            payload = payload_raw
        elif isinstance(payload_raw, str):
            try:
                decoded = json.loads(payload_raw)
            except (json.JSONDecodeError, ValueError):
                decoded = None
            if isinstance(decoded, dict):
                payload = decoded
        elif payload_raw is None and isinstance(args, dict) and args:
            # The model put receipt fields at the top level of arguments
            # instead of nesting under `payload`. Pull them as the payload
            # but strip `next_phase` so it doesn't end up inside the
            # receipt itself.
            collapsed = {k: v for k, v in args.items() if k != "next_phase"}
            if collapsed:
                payload = collapsed

        np_str = args.get("next_phase")
        resolved_next: Phase | None = None
        if isinstance(np_str, str) and np_str:
            try:
                resolved_next = Phase(np_str)
            except ValueError:
                log.warning(
                    "submit_phase_output supplied unknown next_phase=%s; ignored", np_str
                )
                resolved_next = None

        if payload is not None:
            phase_output = payload
            next_phase = resolved_next
            last_malformed = None  # a later good call clears prior malformed
        else:
            reason_bits: list[str] = []
            if payload_raw is None:
                reason_bits.append("missing required field `payload`")
            elif isinstance(payload_raw, str):
                reason_bits.append(
                    "`payload` was a string; tried to JSON-decode it but the "
                    "result was not a JSON object"
                )
            else:
                reason_bits.append(
                    f"`payload` had type {type(payload_raw).__name__}; "
                    "expected a JSON object"
                )
            last_malformed = _MalformedSubmit(
                reason="; ".join(reason_bits),
                arg_keys=sorted(args.keys()) if isinstance(args, dict) else [],
                payload_type=type(payload_raw).__name__ if payload_raw is not None else "missing",
                next_phase_raw=np_str if isinstance(np_str, str) else None,
            )
    return phase_output, next_phase, other_calls, last_malformed


# ── Code-context budget + minimum-context gate (code-context hardening D1/D3) ──

# Static fallback when no model window / policy cap is known. Matches the legacy
# mcp-server default so un-tuned stages behave exactly as before.
_CODE_CONTEXT_DEFAULT_BUDGET = int(os.environ.get("CF_CODE_CONTEXT_DEFAULT_BUDGET", "7000"))
# Fraction of the model's context window we'll spend on the code-context package
# (the rest is prompt + history + output headroom).
_CODE_CONTEXT_WINDOW_FRACTION = float(os.environ.get("CF_CODE_CONTEXT_WINDOW_FRACTION", "0.25"))
# Fraction of the phase's max_input_tokens cap allotted to code context.
_CODE_CONTEXT_INPUT_FRACTION = float(os.environ.get("CF_CODE_CONTEXT_INPUT_FRACTION", "0.6"))
# Hard ceiling — mcp-server's /mcp/code-context/build rejects budgets above 50k.
_CODE_CONTEXT_MAX_BUDGET = 50_000
_CODE_CONTEXT_MIN_BUDGET = 1_000


class MinContextUnavailable(Exception):
    """Raised by run_turn when a code-edit stage that REQUIRES code context gets
    an empty package (no target/editable slices). stage_driver catches this and
    halts the stage with stop_reason=NEEDS_CONTEXT — a human-resumable pause —
    rather than letting the agent edit blind."""

    def __init__(self, *, reason: str, phase: str, context_policy: str | None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.phase = phase
        self.context_policy = context_policy

    def to_dict(self) -> dict[str, Any]:
        return {"reason": self.reason, "phase": self.phase, "context_policy": self.context_policy}


async def _resolve_code_context_budget(
    policy: Any,
    phase: Any,
    phase_model_aliases: dict[str, str] | None,
    model_alias: str | None,
) -> int:
    """Size the code-context token budget to the model + stage policy.

    Budget = the TIGHTEST of {model_window×frac, phase max_input_tokens×frac,
    explicit policy.limits['max_code_context_tokens']}, clamped to [MIN, MAX].
    Falls back to the static default when no signal is available.
    """
    caps: list[int] = []
    phases = getattr(policy, "phases", None)
    phase_pol = phases.get(phase) if isinstance(phases, dict) else None
    if phase_pol is not None and getattr(phase_pol, "max_input_tokens", None):
        caps.append(int(phase_pol.max_input_tokens * _CODE_CONTEXT_INPUT_FRACTION))
    limits = getattr(policy, "limits", None)
    if isinstance(limits, dict):
        explicit = limits.get("max_code_context_tokens")
        if isinstance(explicit, int) and explicit > 0:
            caps.append(explicit)
    alias = (phase_model_aliases or {}).get(getattr(phase, "value", "")) or model_alias
    try:
        window = await context_window_for(alias)
    except Exception:  # noqa: BLE001 — best-effort; never block a turn on this
        window = None
    if isinstance(window, int) and window > 0:
        caps.append(int(window * _CODE_CONTEXT_WINDOW_FRACTION))
    if not caps:
        return _CODE_CONTEXT_DEFAULT_BUDGET
    return max(_CODE_CONTEXT_MIN_BUDGET, min(min(caps), _CODE_CONTEXT_MAX_BUDGET))


def _requires_min_context(ctx_policy: Any, mode: str | None, phase: Any) -> bool:
    """Whether to gate the stage on having minimum code context. An explicit
    `require_min_context` flag wins; otherwise default to gating only CODE_EDIT
    stages (read/verify/story stages never block)."""
    if isinstance(ctx_policy, dict) and "require_min_context" in ctx_policy:
        return bool(ctx_policy.get("require_min_context"))
    return isinstance(mode, str) and mode.strip().upper() == "CODE_EDIT"


def _render_governance_facts(overlay: dict[str, Any]) -> str:
    """Capability Governance Model (G3) — render a resolved governance overlay
    into ONE compact markdown block for `{{governance_facts}}`. ADVISORY: additive
    prompt context only — never blocks, never changes tools/phases (BLOCKING/
    REQUIRED enforcement is a later phase). Returns "" when nothing applies."""
    if not isinstance(overlay, dict):
        return ""
    lines: list[str] = []
    govs = [g for g in (overlay.get("governingEntities") or []) if isinstance(g, dict)]
    if govs:
        names = ", ".join(str(g.get("name") or g.get("capabilityId")) for g in govs)
        if names:
            lines.append(f"- Governed by: {names}.")
    for layer in overlay.get("promptLayers") or []:
        if not isinstance(layer, dict):
            continue
        guidance = layer.get("guidance") or layer.get("text")
        key = layer.get("layerKey")
        if isinstance(guidance, str) and guidance.strip():
            lines.append(f"- {key}: {guidance.strip()}" if key else f"- {guidance.strip()}")
        elif key:
            lines.append(f"- Apply governance guideline: {key}.")
    ev_keys = [str(e.get("evidenceKey")) for e in (overlay.get("requiredEvidence") or [])
               if isinstance(e, dict) and e.get("evidenceKey")]
    if ev_keys:
        lines.append(f"- Evidence expected for this work: {', '.join(ev_keys)}.")
    tp = overlay.get("toolPolicy") or {}
    if isinstance(tp, dict):
        if tp.get("blocked"):
            lines.append(f"- Tools disallowed by governance: {', '.join(map(str, tp['blocked']))}.")
        if tp.get("approvalRequired"):
            lines.append(f"- Tools requiring approval: {', '.join(map(str, tp['approvalRequired']))}.")
    if not lines:
        return ""
    return "## Governance for this stage\n" + "\n".join(lines)


def _summarize_governance_overlay(overlay: dict[str, Any]) -> dict[str, Any]:
    """[P1] Audit summary of WHAT a governance overlay enforced this turn — the
    concrete tools / evidence / controls / layers, not just its hash — so replay
    and audit can reconstruct the governance contribution without re-parsing the
    rendered prompt text. Defensive on shape: every field degrades to empty."""
    tp = overlay.get("toolPolicy")
    tp = tp if isinstance(tp, dict) else {}
    prompt_layers = overlay.get("promptLayers") or []
    layer_keys = [
        str(layer.get("layerKey"))
        for layer in prompt_layers
        if isinstance(layer, dict) and layer.get("layerKey")
    ]
    evidence_keys = [
        str(e.get("evidenceKey"))
        for e in (overlay.get("requiredEvidence") or [])
        if isinstance(e, dict) and e.get("evidenceKey")
    ]
    blocking_controls = [
        str(c.get("controlKey")) if isinstance(c, dict) and c.get("controlKey") else str(c)
        for c in (overlay.get("blockingControls") or [])
        if c
    ]
    return {
        "overlayHash": overlay.get("overlayHash"),
        "effectiveMode": overlay.get("effectiveMode"),
        "governingEntities": [
            g.get("capabilityId")
            for g in (overlay.get("governingEntities") or [])
            if isinstance(g, dict)
        ],
        "blockedTools": [str(t) for t in (tp.get("blocked") or []) if t],
        "approvalRequiredTools": [str(t) for t in (tp.get("approvalRequired") or []) if t],
        "requiredEvidence": evidence_keys,
        "blockingControls": blocking_controls,
        "promptLayerKeys": layer_keys,
        "promptLayerCount": len(prompt_layers) if isinstance(prompt_layers, list) else 0,
    }


def _estimate_input_tokens(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> dict[str, int]:
    """Heuristic pre-flight estimate of the assembled input size.

    Uses the same chars//4 heuristic llm_client applies to its mock usage
    counts — not exact, but enough to catch a budget blowout (a giant
    repo-context prompt, runaway history) BEFORE we pay for the gateway round
    trip. Counts message content + tool_calls payloads + the tool schema list,
    since all three go on the wire.
    """

    def _chars(obj: Any) -> int:
        if obj is None:
            return 0
        if isinstance(obj, str):
            return len(obj)
        try:
            return len(json.dumps(obj, ensure_ascii=False))
        except (TypeError, ValueError):
            return len(str(obj))

    msg_chars = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        msg_chars += _chars(m.get("content")) + _chars(m.get("tool_calls"))
    tool_chars = _chars(tools) if tools else 0
    return {
        "messages": msg_chars // 4,
        "tools": tool_chars // 4,
        "total": (msg_chars + tool_chars) // 4,
    }


async def run_turn(
    *,
    state: PhaseState,
    stage_key: str,
    agent_role: str | None,
    vars: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    # M100 — per-phase model override. Maps a governed Phase value
    # (PLAN/EXPLORE/ACT/VERIFY/REPAIR/SELF_REVIEW/FINALIZE) → model alias.
    # When the CURRENT phase has an entry it wins over the stage-level
    # `model_alias`; phases with no entry (and unknown keys) fall back to
    # `model_alias`, then the gateway default. None preserves the legacy
    # single-model-per-stage behavior verbatim.
    phase_model_aliases: dict[str, str] | None = None,
    run_context: dict[str, Any] | None = None,
    bearer: str | None = None,
    # M83.r — Anthropic extended thinking budget. None / 0 → off.
    # When >0, the gateway enables thinking on Anthropic providers and
    # the returned TurnResult.llm carries thinking_blocks for history
    # threading + operator inspection in LoopTrace.
    thinking_budget: int | None = None,
    # M91.A — workflow-resolved policy override. When set, narrows the
    # DB-seeded StagePolicy's per-phase allowed_tools by the workflow
    # designer's tool_policy / repo_access fields. None preserves
    # legacy behavior (DB seed verbatim).
    exec_policy: StageExecutionPolicy | None = None,
    # M98 P3 (2026-05-29) — per-attempt code-context cache. run_stage()
    # passes a dict that lives for exactly one attempt; run_turn() stores
    # the built code_context_package markdown here keyed by its build
    # inputs and reuses it across turns instead of re-AST-indexing the
    # repo on every turn. None (the default, used by execute.py + tests)
    # preserves the rebuild-every-turn behavior. Kept OUT of run_context
    # on purpose: dispatch.py ships run_context to mcp-server on every
    # tool call, so stashing multi-KB markdown there would bloat the wire.
    code_context_cache: dict[str, Any] | None = None,
    # Capability Governance Model (G3) — resolved governance overlay (from IAM,
    # threaded by the caller). When present, its advisory guidance is rendered
    # into `{{governance_facts}}`. None preserves legacy behavior exactly.
    governance_overlay: dict[str, Any] | None = None,
) -> TurnResult:
    """Run one LLM turn end-to-end:

      1. Load StagePolicy.
      2. Resolve the per-phase prompt.
      3. Build messages + tool descriptors.
      4. Call llm-gateway.
      5. Parse tool calls, extract submit_phase_output.
      6. Run governance oracle.
      7. Return everything the caller needs to persist + render.

    Raises:
      PolicyNotFoundError   — no StagePolicy for this (stage_key, role).
      PromptNotFoundError   — no StagePromptBinding for this (stage_key, role, phase).
      LLMGatewayError       — endpoint-level LLM failure (timeout / 5xx / 429).
                              The caller decides whether to retry or surface.
    """
    history = history or []
    # Use a local copy so we don't mutate the caller's dict when we
    # inject the code-context-package below.
    vars = dict(vars or {})

    # 1. Policy.
    policy = await load_stage_policy(stage_key, agent_role, bearer=bearer)
    # M91.A — apply workflow-resolved override (filters per-phase
    # allowed_tools by tool_policy + repo_access). No-op when
    # exec_policy is None. The DB seed remains the source of phase
    # definitions, budgets, validators; the override only NARROWS
    # which specific tools are exposed to the LLM this turn.
    policy = apply_execution_policy(policy, exec_policy)

    # Architecture gap #5 (2026-05-23) — code-context-package
    # integration. When the stage opts in via
    # context_policy.include_code_context_package, fetch the AST-
    # budgeted package from mcp-server and surface its markdown to
    # the per-phase prompt via vars["code_context_package"]. The
    # legacy /execute path has had this since M52; without this
    # injection the governed loop was strictly weaker for code-edit
    # stages.
    #
    # Opt-in (not default) so existing policies don't suddenly start
    # making an mcp-server round-trip on every turn. Fail-soft —
    # any error degrades to the existing prompt without breaking
    # the loop.
    ctx_policy = policy.context_policy if policy else {}

    # M90.F (2026-05-27) — surface context_policy fields to prompt vars
    # so per-phase templates can reference them. Pre-M90.F the seed
    # defined ast_first / full_file_read_requires_justification /
    # large_file_threshold_lines / require_context_receipt but nothing
    # consumed them. Now: they land in vars["context_policy"] and
    # individual top-level keys for template author convenience.
    # The loop.py runtime separately consumes large_file_threshold_lines
    # to emit governed.large_file_read audit events; the rest of the
    # fields are advisory until they're baked into prompt templates.
    if isinstance(ctx_policy, dict):
        vars.setdefault("context_policy", dict(ctx_policy))
        if ctx_policy.get("ast_first") is not None:
            vars.setdefault("policy_ast_first", bool(ctx_policy.get("ast_first")))
        if ctx_policy.get("full_file_read_requires_justification") is not None:
            vars.setdefault(
                "policy_full_file_read_requires_justification",
                bool(ctx_policy.get("full_file_read_requires_justification")),
            )
        thr = ctx_policy.get("large_file_threshold_lines")
        if isinstance(thr, int) and thr > 0:
            vars.setdefault("policy_large_file_threshold_lines", thr)

        # M99 S3.2 — render the resolved policy facts (+ any localization
        # summary the stage_driver injected) into ONE compact markdown block
        # so a prompt template can drop in `{{policy_facts}}` instead of
        # repeating static per-phase/tool prose. CF owns the rendering; the
        # template-author side (referencing the var) is a prompt-composer
        # seed follow-up. setdefault so an upstream caller can override; the
        # block is empty-string when there are no facts (template renders
        # nothing). Advisory: changes nothing until a template references it.
        vars.setdefault("policy_facts", _render_policy_facts(ctx_policy, vars))

    # Capability Governance Model (G3) — compile the resolved governance overlay
    # into the prompt as advisory context (`{{governance_facts}}`) + emit an audit
    # event for observability. Additive only; never blocks or alters tools/phases.
    if isinstance(governance_overlay, dict) and governance_overlay and isinstance(vars, dict):
        gov_facts = _render_governance_facts(governance_overlay)
        if gov_facts:
            vars.setdefault("governance_facts", gov_facts)
        await emit_governed_event(
            kind="governed.governance_applied",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                # [P1] Record WHAT governance contributed this turn (blocked /
                # approval tools, required evidence, blocking controls, prompt
                # layers) — not just the overlay hash — so the audit is complete
                # without re-parsing the rendered prompt.
                **_summarize_governance_overlay(governance_overlay),
                "governanceFactsInjected": bool(gov_facts),
                "governanceFactsChars": len(gov_facts) if gov_facts else 0,
            },
        )

    if isinstance(ctx_policy, dict) and ctx_policy.get("include_code_context_package"):
        goal_text = ""
        if isinstance(vars.get("goal"), str):
            goal_text = vars["goal"]
        elif isinstance(vars.get("task"), str):
            goal_text = vars["task"]
        capability_id = None
        if isinstance(run_context, dict):
            capability_id = (
                run_context.get("capability_id")
                or run_context.get("capabilityId")
            )

        # M98 P3 (2026-05-29) — reuse the package across turns within an
        # attempt. build_code_context_for_governed_turn() POSTs to
        # mcp-server's /mcp/code-context/build, which AST-indexes the repo
        # (a 45s-budget round trip). Its only inputs — goal_text +
        # capability_id — are constant for the life of an attempt, yet
        # pre-M98 we rebuilt the package on EVERY turn, paying that index
        # cost N times for an N-turn attempt. The package is an orientation
        # map of the *existing* repo, not ground truth (the agent reads
        # live file state through its own tools), so serving it after the
        # agent's in-flight edits is acceptable — and matches the legacy
        # /execute path, which built it once per attempt, not per turn.
        # GOVERNED_CODE_CONTEXT_CACHE=0 forces the old rebuild-every-turn
        # behavior for debugging.
        # Include the phase in the signature: the code-context budget is
        # phase-derived (_resolve_code_context_budget(..., state.current_phase, ...)),
        # so a PLAN-phase package (smaller budget) must not be reused for a later
        # ACT phase. Same goal+capability within one phase still hits the cache.
        cache_sig = [goal_text, capability_id or "", state.current_phase.value]
        cache_enabled = (
            code_context_cache is not None
            and os.environ.get("GOVERNED_CODE_CONTEXT_CACHE", "1").lower()
            not in ("0", "false", "no")
        )
        cached = code_context_cache if cache_enabled else None

        if (
            isinstance(cached, dict)
            and cached.get("sig") == cache_sig
            and isinstance(cached.get("md"), str)
            and cached.get("md")
        ):
            vars["code_context_package"] = cached["md"]
            vars["code_context_package_id"] = cached.get("pkg_id", "")
            await emit_governed_event(
                kind="governed.code_context_cache_hit",
                state=state,
                policy=policy,
                run_context=run_context,
                payload={
                    "context_package_id": cached.get("pkg_id"),
                    "markdown_bytes": len(cached["md"]),
                },
            )
        else:
            # D1 — size the budget to the model window + stage/phase caps
            # instead of a static 7000. D2 (threading) — pass the stage's
            # context_policy MODE so the builder can scope non-tool context
            # (mcp-side slice scoping is a documented follow-up).
            budget = await _resolve_code_context_budget(
                policy, state.current_phase, phase_model_aliases, model_alias
            )
            context_policy_mode = (
                exec_policy.context_policy if exec_policy is not None else None
            )
            pkg, reason = await build_code_context_for_governed_turn(
                task_text=goal_text,
                capability_id=capability_id,
                run_context=run_context,
                max_token_budget=budget,
                context_policy=context_policy_mode,
                # Placement: when this run is on a laptop, build the world model
                # against that laptop's worktree (over the code-context bridge
                # frame) instead of the box's shared sandbox. None → cloud HTTP.
                # Mirrors tool dispatch (loop.py). See placement.py.
                laptop_user_id=_placement.mcp_laptop_target(run_context),
                runtime_tenant_id=_placement.runtime_tenant_target(run_context),
                runtime_capability_tags=_placement.runtime_capability_tags(run_context),
            )
            if pkg is not None:
                md = package_markdown(pkg)
                if md:
                    vars["code_context_package"] = md
                    vars["code_context_package_id"] = pkg.get("context_package_id", "")
                    # Cache successes only. A transient mcp-server failure
                    # shouldn't poison the rest of the attempt — leaving the
                    # cache empty lets the next turn retry the build.
                    if cache_enabled and code_context_cache is not None:
                        code_context_cache["sig"] = cache_sig
                        code_context_cache["md"] = md
                        code_context_cache["pkg_id"] = pkg.get("context_package_id", "")
                    await emit_governed_event(
                        kind="governed.code_context_attached",
                        state=state,
                        policy=policy,
                        run_context=run_context,
                        payload={
                            "context_package_id": pkg.get("context_package_id"),
                            "markdown_bytes": len(md),
                        },
                    )
            else:
                # Surfaces the reason in audit-gov so operators see the
                # degradation without it changing agent behavior.
                await emit_governed_event(
                    kind="governed.code_context_skipped",
                    state=state,
                    policy=policy,
                    run_context=run_context,
                    payload={"reason": reason or "unknown"},
                    severity="warn",
                )

            # D3 — minimum-context gate. A code-edit stage that REQUIRES context
            # must not proceed with an empty package (no target/editable slices):
            # raising MinContextUnavailable pauses the stage for a human
            # (stage_driver → stop_reason=NEEDS_CONTEXT) instead of editing blind.
            if _requires_min_context(ctx_policy, context_policy_mode, state.current_phase):
                target_ct = len(pkg.get("target_symbols") or []) if isinstance(pkg, dict) else 0
                editable_ct = len(pkg.get("editable_slices") or []) if isinstance(pkg, dict) else 0
                if target_ct == 0 and editable_ct == 0:
                    await emit_governed_event(
                        kind="governed.min_context_gate",
                        state=state,
                        policy=policy,
                        run_context=run_context,
                        payload={
                            "reason": reason or "no target/editable slices",
                            "context_policy": context_policy_mode,
                            "phase": state.current_phase.value,
                            "target_symbols": target_ct,
                            "editable_slices": editable_ct,
                        },
                        severity="warn",
                    )
                    raise MinContextUnavailable(
                        reason=reason or "code-context package has no target/editable slices",
                        phase=state.current_phase.value,
                        context_policy=context_policy_mode,
                    )

    # 2. Prompt — phase-specific if a binding exists, falls back via the
    # composer's ladder otherwise.
    #
    # M93.F (2026-05-27) — When the workflow's StageExecutionPolicy pins a
    # specific prompt_profile_key, forward it to the composer so the
    # named StagePromptBinding is used directly (bypassing the
    # (stage_key, agent_role) resolver ladder). Pre-M93.F this field
    # on the Pydantic model was documented but not consumed — runtime
    # prompts ignored the workflow's pinned profile.
    # #25 — capability id for read-only long-term-memory grounding (the composer
    # appends the capability's promoted distilled memory to extraContext).
    # Resolved independently of the code-context block above, which may not run.
    _resolve_capability_id = None
    if isinstance(run_context, dict):
        _resolve_capability_id = (
            run_context.get("capability_id") or run_context.get("capabilityId") or None
        )
    prompt = await resolve_phase_prompt(
        stage_key=stage_key,
        agent_role=agent_role,
        phase=state.current_phase,
        vars=vars,
        bearer=bearer,
        prompt_profile_key=(exec_policy.prompt_profile_key if exec_policy is not None else None),
        capability_id=_resolve_capability_id,
    )

    # 3. Messages + tool descriptors.
    messages = _build_messages(prompt, history)
    # G4 governance overlay — tools the governing entity blocks (or requires
    # approval for) are enforced, not just rendered as advisory text: excluded
    # from the LLM's tool list here and hard-refused at dispatch (governed_step).
    # Enforce the unambiguous `blocked` list (hard refuse). `approvalRequired`
    # stays advisory for now — a per-tool approval gate in the governed loop is a
    # separate feature; blocking those outright would break the intended
    # run-after-approval flow.
    _gov_tp = (governance_overlay or {}).get("toolPolicy") if isinstance(governance_overlay, dict) else None
    _blocked_tools: set[str] = set()
    if isinstance(_gov_tp, dict):
        _blocked_tools.update(str(t) for t in (_gov_tp.get("blocked") or []) if t)
    effective_capabilities = effective_capabilities_from_context(run_context)
    if effective_capabilities_required_but_empty(run_context):
        await emit_governed_event(
            kind="governed.effective_capabilities_empty",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "reason": "effective_capabilities_required_but_empty",
                "stage_key": stage_key,
                "phase": state.current_phase.value,
                "agent_role": agent_role,
            },
            severity="warn",
        )
    tools = _build_tool_descriptors(
        policy,
        state.current_phase,
        _blocked_tools or None,
        effective_capabilities,
        effective_capabilities_required(run_context),
    )

    # M100 — resolve the effective model alias for THIS phase (a per-phase
    # override wins over the stage-level alias, then the gateway default).
    # Resolved here, ahead of the call, so the token pre-flight can fall back to
    # the model's context window when no explicit phase cap is set.
    effective_model_alias = (
        (phase_model_aliases or {}).get(state.current_phase.value) or model_alias
    )

    # Token-budget pre-flight (P1) — estimate the assembled input size and check
    # it against a cap before paying for the gateway round trip. Cap = THIS
    # phase's max_input_tokens when governance sets one, else the model's context
    # window (so the check still fires in the common case where no explicit input
    # budget is configured). We record the estimate on every request (cost
    # accounting) and warn below when it blows the cap.
    _token_estimate = _estimate_input_tokens(messages, tools)
    _phase_pol = (
        policy.phases.get(state.current_phase)
        if policy is not None and isinstance(getattr(policy, "phases", None), dict)
        else None
    )
    _input_token_cap = getattr(_phase_pol, "max_input_tokens", None) if _phase_pol else None
    _cap_source = "phase_max_input_tokens" if _input_token_cap else None
    if not _input_token_cap:
        # Best-effort; context_window_for returns None on a cold cache miss.
        _input_token_cap = await context_window_for(effective_model_alias)
        if _input_token_cap:
            _cap_source = "model_context_window"

    # Audit the LLM call now — useful for cost accounting even when the
    # call fails. The completion event lands after the response below.
    request_payload: dict[str, Any] = {
        "binding_id": prompt.binding_id,
        "prompt_profile_id": prompt.prompt_profile_id,
        "tool_count": len(tools),
        "history_messages": len(history),
        "estimated_input_tokens": _token_estimate["total"],
        "input_token_cap": _input_token_cap,
        "input_token_cap_source": _cap_source,
    }
    if _CAPTURE_FULL_PROMPT:
        # Composed prompt for the Workbench "Full prompt sent" panel — CAPPED +
        # secret-masked (code-context E2) so a large repo-context prompt can't
        # bloat the audit store and tokens aren't leaked into the ledger. Tool
        # names included so the operator sees what was offered; full tool JSON
        # schemas are omitted (large + cache-stable, recoverable from the registry).
        request_payload["messages"] = _sanitize_captured_messages(messages)
        request_payload["tool_names"] = [
            ((t.get("function") or {}).get("name") if isinstance(t, dict) else None)
            or (t.get("name") if isinstance(t, dict) else None)
            for t in tools
        ]
    await emit_governed_event(
        kind="governed.llm_request",
        state=state,
        policy=policy,
        run_context=run_context,
        payload=request_payload,
    )

    if _input_token_cap and _token_estimate["total"] > _input_token_cap:
        # Pre-flight tripped: the assembled input is over this phase's cap. Surface
        # it before the call so the budget machinery / operators see it (the
        # workgraph budgetPolicy owns the hard PAUSE_FOR_APPROVAL response).
        await emit_governed_event(
            kind="governed.token_budget_exceeded",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "phase": state.current_phase.value,
                "estimated_input_tokens": _token_estimate["total"],
                "input_token_cap": _input_token_cap,
                "input_token_cap_source": _cap_source,
                "overage_tokens": _token_estimate["total"] - _input_token_cap,
                "breakdown": {
                    "messages": _token_estimate["messages"],
                    "tools": _token_estimate["tools"],
                    "history_messages": len(history),
                },
            },
            severity="warn",
        )

    # 4. LLM call. (effective_model_alias was resolved above for the pre-flight.)
    response: ChatResponse = await call_gateway_chat(
        messages=messages,
        tools=tools,
        model_alias=effective_model_alias,
        bearer=bearer,
        thinking_budget=thinking_budget,
        # Placement: when this run opted into laptop LLM (and a laptop is serving
        # model-run), call_gateway_chat dispatches over the bridge; otherwise it
        # uses the cloud gateway. None in the common case. See placement.py.
        laptop_user_id=_placement.llm_laptop_target(run_context),
        runtime_tenant_id=_placement.runtime_tenant_target(run_context),
        runtime_capability_tags=_placement.runtime_capability_tags(run_context),
    )

    await emit_governed_event(
        kind="governed.llm_response",
        state=state,
        policy=policy,
        run_context=run_context,
        payload={
            "finish_reason": response.finish_reason,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "tool_call_count": len(response.tool_calls),
            "provider": response.provider,
            "model": response.model,
            "model_alias": response.model_alias,
            # M100 — the alias we REQUESTED for this phase (post per-phase
            # override resolution). `model_alias` above is what the gateway
            # actually resolved/served; surfacing both lets LoopTrace show
            # per-phase routing even when they differ from the stage default.
            "requested_model_alias": effective_model_alias,
            "latency_ms": response.latency_ms,
            "estimated_cost": response.estimated_cost,
            # ADR 0003 — prompt-cache usage so hit rate is observable in
            # run insights (cache_read = cheap hit, cache_creation = write).
            "prompt_cache": response.prompt_cache,
            # M83.r + loop-trace-rewire — surface the response content
            # AND the structured tool calls so the workbench LoopTrace
            # UI can reconstruct the per-step view from audit-gov
            # events instead of relying on mcp-server's audit store
            # (which has no data post-M71). Capped to avoid bloating
            # the events table; the workbench truncates further.
            "content": (response.content or "")[:8000],
            "tool_calls": [
                {"id": tc.id, "name": tc.name, "args": tc.arguments}
                for tc in response.tool_calls
            ],
            # M83.r — thinking blocks content + counts.
            # M90.D (2026-05-27) — content gated by AUDIT_CAPTURE_THINKING.
            # Default off; the count + token total still ship so the
            # workbench can show the "thinking" chip. Content lights up
            # only when an operator enables the env var for debugging.
            # Reasoning: thinking is the model's internal chain of
            # thought — useful for diagnosis, but verbose and not
            # something we want in default audit payloads.
            "thinking_blocks": [
                {
                    "thinking": (tb.get("thinking") or "")[:4000],
                    "redacted": tb.get("redacted", False),
                }
                for tb in (response.thinking_blocks or [])
            ] if _AUDIT_CAPTURE_THINKING else [],
            "thinking_block_count": len(response.thinking_blocks),
            "thinking_tokens": response.thinking_tokens,
            "thinking_capture": "full" if _AUDIT_CAPTURE_THINKING else "counts_only",
        },
    )

    # 5. Split tool calls.
    phase_output, next_phase, other_calls, malformed = _extract_phase_output(
        response.tool_calls
    )

    # 5a. (Code-review fix 2026-05-24) — surface malformed submit_phase_output
    # calls instead of silently dropping them. Without this:
    #   - no audit event fires (operators can't tell why a stage stalled),
    #   - the LLM gets no validation feedback (the stage_driver's
    #     validation-error injection only runs when step.validation_error
    #     is set), and
    #   - the stagnant-turn guard eventually fires POLICY_BLOCKED, which
    #     looks like a refusal but is actually a shape bug.
    # We emit the event AND set a validation_error on the synthesized step
    # result so stage_driver's existing retry/feedback path takes over.
    if malformed is not None and phase_output is None and not other_calls:
        log.info(
            "submit_phase_output malformed phase=%s reason=%s",
            state.current_phase.value,
            malformed.reason,
        )
        await emit_governed_event(
            kind="governed.submit_phase_output_malformed",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "phase": state.current_phase.value,
                "reason": malformed.reason,
                "arg_keys": malformed.arg_keys,
                "payload_type": malformed.payload_type,
                "next_phase_raw": malformed.next_phase_raw,
            },
            severity="warn",
        )
        # Build a synthetic GovernedStepResult so the driver's existing
        # validation_error retry path injects a corrective message into
        # the next turn. We bypass governed_step entirely (nothing to
        # dispatch and no receipt to validate) but keep the shape it
        # would have produced.
        synthetic_step = GovernedStepResult(
            next_state=state,
            from_phase=state.current_phase.value,
            to_phase=state.current_phase.value,
            validation_error={
                "error_code": "SUBMIT_PHASE_OUTPUT_MALFORMED",
                "phase": state.current_phase.value,
                "reason": (
                    "Your last submit_phase_output call could not be parsed: "
                    f"{malformed.reason}. The synthetic tool expects "
                    "arguments shaped exactly as "
                    "{ payload: <object>, next_phase: <PHASE NAME or omit> }. "
                    "`payload` must be a JSON object, not a string. Put the "
                    "receipt fields described in your prompt INSIDE `payload`."
                ),
                "details": [
                    {"field": "payload", "issue": malformed.reason},
                ],
                "arg_keys_seen": malformed.arg_keys,
                "payload_type_seen": malformed.payload_type,
            },
        )
        return TurnResult(
            next_state=state,
            step=synthetic_step,
            llm={
                "content": response.content,
                "finish_reason": response.finish_reason,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "latency_ms": response.latency_ms,
                "provider": response.provider,
                "model": response.model,
                "model_alias": response.model_alias,
                "estimated_cost": response.estimated_cost,
                "tool_call_count": len(response.tool_calls),
                # M83.r — thinking blocks captured from the LLM response.
                # stage_driver threads these back into the next assistant
                # message via ChatMessage.thinking_blocks (required for
                # Anthropic tool-use continuation). Workbench LoopTrace
                # surfaces them as a "Deep reasoning" expandable section.
                "thinking_blocks": [dict(tb) for tb in response.thinking_blocks],
                "thinking_tokens": response.thinking_tokens,
            },
            prompt={
                "binding_id": prompt.binding_id,
                "prompt_profile_id": prompt.prompt_profile_id,
                "phase_used": prompt.phase,
                "stage_key": prompt.stage_key,
                "agent_role": prompt.agent_role,
            },
            policy={
                "policy_id": policy.policy_id,
                "stage_key": policy.stage_key,
                "agent_role": policy.agent_role,
                "version": policy.version,
                "max_repair_attempts": policy.max_repair_attempts,
            },
        )

    # 5b. No tool call at all is also a stagnant-turn risk — the LLM
    # produced prose but didn't advance. Emit a marker event so the
    # silent stagnant→POLICY_BLOCKED path is observable. We don't synthesize
    # a validation_error here because the prompt itself may have asked for
    # a thought-only turn (rare but allowed); the stagnant guard will still
    # halt the stage after _STAGNANT_THRESHOLD repetitions.
    if (
        phase_output is None
        and not other_calls
        and malformed is None
        and len(response.tool_calls) == 0
    ):
        await emit_governed_event(
            kind="governed.no_tool_called",
            state=state,
            policy=policy,
            run_context=run_context,
            payload={
                "phase": state.current_phase.value,
                "content_chars": len(response.content or ""),
                "finish_reason": response.finish_reason,
            },
            severity="warn",
        )

    # 6. Hand to the governance oracle. Tool calls go through hard-refuse;
    # phase_output goes through the validator + state machine.
    dispatch_payloads = [
        {"tool_name": tc.name, "args": tc.arguments, "id": tc.id}
        for tc in other_calls
    ]
    step = await governed_step(
        state=state,
        stage_key=stage_key,
        agent_role=agent_role,
        tool_calls=dispatch_payloads,
        phase_output=phase_output,
        next_phase=next_phase,
        run_context=run_context,
        bearer=bearer,
        policy=policy,
        blocked_tools=_blocked_tools or None,
    )

    return TurnResult(
        next_state=step.next_state,
        step=step,
        llm={
            "content": response.content,
            "finish_reason": response.finish_reason,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "latency_ms": response.latency_ms,
            "provider": response.provider,
            "model": response.model,
            "model_alias": response.model_alias,
            "estimated_cost": response.estimated_cost,
            "tool_call_count": len(response.tool_calls),
        },
        prompt={
            "binding_id": prompt.binding_id,
            "prompt_profile_id": prompt.prompt_profile_id,
            "phase_used": prompt.phase,
            "stage_key": prompt.stage_key,
            "agent_role": prompt.agent_role,
        },
        policy={
            "policy_id": policy.policy_id,
            "stage_key": policy.stage_key,
            "agent_role": policy.agent_role,
            "version": policy.version,
            "max_repair_attempts": policy.max_repair_attempts,
        },
    )
