"""
M71 — Phase-output validators.

When the agent submits a phase output (the structured JSON it produced this
turn), we validate it against the Pydantic model registered for that phase
in `receipts.py`. Validation failures become PHASE_OUTPUT_INVALID 400s back
to the LLM with the missing/wrong fields enumerated so the model can self-
correct without burning a full retry.

There are two layers of validation:
  1. The Pydantic model (strict — required fields, enum values, types).
  2. The JSON-schema-ish `requiredOutputSchema` from prompt-composer's
     StagePhasePolicy (lighter — for cases where a stage wants to demand a
     field beyond what the canonical receipt expects, e.g. "this stage's
     PlanReceipt must include `mitigation_for_regression_risk`").

We run Pydantic first because it's authoritative for the receipt shape; the
policy-schema layer adds project-specific extras on top.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from .phase_state import Phase, PhaseState
from .policy_loader import StagePolicy
from .receipts import receipt_for_phase


class PhaseOutputInvalid(ValueError):
    """Raised when phase output doesn't satisfy the receipt schema. Carries
    a structured `details` list so the agent can fix one field at a time."""

    error_code = "PHASE_OUTPUT_INVALID"

    def __init__(self, phase: Phase, details: list[dict[str, Any]], reason: str):
        super().__init__(reason)
        self.phase = phase
        self.details = details
        self.reason = reason

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_code": self.error_code,
            "phase": self.phase.value,
            "reason": self.reason,
            "details": self.details,
        }


# M87 (2026-05-27) — Repair-receipt auto-fill.
#
# Repro: develop attempt 93af88cb cycled REPAIR twice, both times the
# RepairReceipt validator rejected the submission for missing
# `retry_number` and `failure_summary` — fields the platform already
# knows from `state.repair_attempts` and the most recent
# VerificationReceipt. The agent then misread the bounce as a phase
# advance and called a VERIFY-only tool, burning the rest of MAX_TURNS.
#
# Fix: fill those two fields server-side before pydantic runs.
# `repair_hypothesis` stays required (it's the only field that demands
# real model judgment about WHY the previous attempt failed, not just
# WHAT failed).
def _autofill_repair_receipt(
    payload: dict[str, Any], state: PhaseState | None
) -> dict[str, Any]:
    """Inject server-derivable fields into a REPAIR payload so the model
    can focus on the substantive content.

    Idempotent — only writes a field when missing/empty. Returns a new
    dict; never mutates the caller's payload.
    """
    if state is None:
        return payload
    enriched: dict[str, Any] = {**payload}

    # retry_number — 1-based count of repair entries this stage.
    if not isinstance(enriched.get("retry_number"), int) or enriched["retry_number"] < 1:
        prior = state.receipts.get(Phase.REPAIR.value) or []
        enriched["retry_number"] = len(prior) + 1

    # failure_summary — derive from the last VerificationReceipt the
    # phase state holds. The summary need not be exhaustive; truncating
    # to a single line keeps the receipt readable in audit-gov.
    summary = enriched.get("failure_summary")
    if not isinstance(summary, str) or not summary.strip():
        verif_receipts = state.receipts.get(Phase.VERIFY.value) or []
        if verif_receipts:
            latest = verif_receipts[-1]
            if isinstance(latest, dict):
                # Receipt fields vary by source (tool / human / auto);
                # try the most common spots in order.
                fallback = (
                    latest.get("failure_summary")
                    or latest.get("summary")
                    or latest.get("stdout_excerpt")
                    or latest.get("stdoutExcerpt")
                    or latest.get("error")
                    or latest.get("command")
                    or "Previous verification failed; see the verification receipt."
                )
                if isinstance(fallback, str):
                    # Single-line, capped — the model can read the full
                    # receipt via the history if it needs more.
                    fallback = fallback.strip().splitlines()[0][:240]
                    enriched["failure_summary"] = (
                        fallback or "Previous verification failed."
                    )
        # Last-ditch: if we have no verification receipts at all, still
        # populate the field so the validator doesn't choke. The agent
        # can override it on the next submission.
        if not enriched.get("failure_summary"):
            enriched["failure_summary"] = "Previous attempt did not pass verification."

    return enriched


def _check_policy_required(
    payload: dict[str, Any], required_schema: dict[str, Any]
) -> list[dict[str, Any]]:
    """Light JSON-schema-ish check. We only enforce `required` because the
    type/format work is already covered by Pydantic upstream. The schema
    field comes verbatim from StagePhasePolicy.requiredOutputSchema."""
    issues: list[dict[str, Any]] = []
    required: list[str] = list(required_schema.get("required") or [])
    for field_name in required:
        if field_name not in payload:
            issues.append({"field": field_name, "issue": "required field missing"})
    return issues


def validate_phase_output(
    phase: Phase,
    payload: dict[str, Any],
    policy: StagePolicy | None = None,
    state: PhaseState | None = None,
) -> dict[str, Any]:
    """Validate `payload` against the receipt schema for `phase`.

    Returns the parsed-and-dumped receipt dict (with `kind`+`created_at`
    stamped). Raises `PhaseOutputInvalid` on either Pydantic or policy-schema
    failures, with `.details` enumerating each problem.

    Passing `policy=None` skips the policy-schema layer; pass the loaded
    StagePolicy to also enforce stage-specific required-field overrides.

    `state` (optional) enables M87 server-side auto-fill for fields the
    platform already knows (currently REPAIR's retry_number +
    failure_summary). Pass None in unit tests that exercise the raw
    Pydantic schema.
    """
    agent_role = policy.agent_role if policy is not None else None
    model_cls = receipt_for_phase(phase, agent_role=agent_role)
    if model_cls is None:
        # FINALIZE has no canonical receipt; nothing to validate beyond what
        # the loop already enforces (allowlist + finalize artifacts). Echo
        # payload back with a kind hint so audit-gov can still bucket it.
        return {"kind": f"{phase.value.lower()}_artifact", **payload}

    # Inject the kind field if the agent omitted it; this is the only
    # reasonable nudge — every receipt model has a fixed `kind`.
    enriched = {**payload}
    enriched.setdefault("kind", model_cls.model_fields["kind"].default)

    # M87 — per-phase server-side auto-fill before Pydantic runs. Only
    # active for phases where the platform genuinely owns a field (no
    # creative judgment delegated). Keep this list short and explicit.
    if phase is Phase.REPAIR:
        enriched = _autofill_repair_receipt(enriched, state)

    try:
        instance = model_cls.model_validate(enriched)
    except ValidationError as exc:
        # Pydantic returns `loc=(field, sub-field, …)` for nested errors.
        # Flatten into a JSON-friendly path for the agent to read.
        details = [
            {
                "field": ".".join(str(p) for p in err.get("loc", [])) or "<root>",
                "issue": err.get("msg", "invalid"),
                "type": err.get("type", "value_error"),
            }
            for err in exc.errors()
        ]
        raise PhaseOutputInvalid(
            phase=phase,
            details=details,
            reason=f"{model_cls.__name__} validation failed",
        ) from exc

    parsed = instance.model_dump(mode="json")

    # Now the lighter, policy-defined required-fields layer.
    if policy is not None:
        phase_policy = policy.phases.get(phase)
        if phase_policy is not None:
            issues = _check_policy_required(parsed, phase_policy.required_output_schema)
            if issues:
                raise PhaseOutputInvalid(
                    phase=phase,
                    details=issues,
                    reason="StagePolicy.requiredOutputSchema violated",
                )

    return parsed
