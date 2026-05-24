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

from .phase_state import Phase
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
) -> dict[str, Any]:
    """Validate `payload` against the receipt schema for `phase`.

    Returns the parsed-and-dumped receipt dict (with `kind`+`created_at`
    stamped). Raises `PhaseOutputInvalid` on either Pydantic or policy-schema
    failures, with `.details` enumerating each problem.

    Passing `policy=None` skips the policy-schema layer; pass the loaded
    StagePolicy to also enforce stage-specific required-field overrides.
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
