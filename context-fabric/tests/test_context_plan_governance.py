from context_api_service.app.execute import _context_plan_message, _context_plan_status, _governance_mode
from pathlib import Path


def test_governance_mode_normalizes_known_values():
    assert _governance_mode("FAIL_CLOSED") == "fail_closed"
    assert _governance_mode(" degraded ") == "degraded"
    assert _governance_mode("human_approval_required") == "human_approval_required"


def test_governance_mode_defaults_unknown_values_to_fail_open():
    assert _governance_mode(None) == "fail_open"
    assert _governance_mode("panic") == "fail_open"


def test_governance_mode_uses_explicit_fallback_for_invalid_values():
    assert _governance_mode(None, fallback="fail_closed") == "fail_closed"
    assert _governance_mode("panic", fallback="fail_closed") == "fail_closed"


def test_context_plan_status_requires_composer_when_agent_template_flow_runs():
    status = _context_plan_status(None, composer_available=False)

    assert status["valid"] is False
    assert status["reason"] == "composer_unavailable"
    assert status["missingRequired"][0]["layerType"] == "CONTEXT_PLAN"


def test_context_plan_status_requires_a_plan_from_composer():
    status = _context_plan_status(None, composer_available=True)

    assert status["valid"] is False
    assert status["reason"] == "context_plan_missing"
    assert status["missingRequired"][0]["layerType"] == "CONTEXT_PLAN"


def test_context_plan_status_accepts_valid_plan():
    plan = {
        "valid": True,
        "missingRequired": [],
        "contextPlanHash": "sha256:ok",
        "requiredLayers": [{"layerType": "PLATFORM_CONSTITUTION", "present": True}],
        "selectedLayers": [{"layerType": "PLATFORM_CONSTITUTION"}],
    }

    status = _context_plan_status(plan, composer_available=True)

    assert status["valid"] is True
    assert status["reason"] is None
    assert status["contextPlanHash"] == "sha256:ok"
    assert status["selectedLayerCount"] == 1


def test_context_plan_status_rejects_missing_required_layers():
    missing = [{"layerType": "AGENT_ROLE", "suggestedFix": "Enable the agent role layer."}]
    plan = {"valid": False, "missingRequired": missing, "contextPlanHash": "sha256:bad"}

    status = _context_plan_status(plan, composer_available=True)

    assert status["valid"] is False
    assert status["reason"] == "missing_required_context"
    assert status["missingRequired"] == missing
    assert status["contextPlanHash"] == "sha256:bad"


def test_context_plan_message_names_missing_layers_for_operator_fix():
    status = {
        "missingRequired": [
            {"layerType": "PLATFORM_CONSTITUTION"},
            {"layerType": "AGENT_ROLE"},
            {"layerType": "TASK_CONTEXT"},
        ]
    }

    message = _context_plan_message(status)

    assert "PLATFORM_CONSTITUTION" in message
    assert "AGENT_ROLE" in message
    assert "TASK_CONTEXT" in message


def test_context_plan_approval_does_not_force_fail_open_retry():
    source = Path(__file__).parents[1] / "services/context_api_service/app/execute.py"
    text = source.read_text()

    assert 'approved_request["governance_mode"] = "fail_open"' not in text
    assert "approvedContextPlanBypass" in text
    assert "bypassedRequiredContextStatus" in text
    assert "bypassed the missing context plan once" in text
