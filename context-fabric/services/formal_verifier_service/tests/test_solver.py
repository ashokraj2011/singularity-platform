from services.formal_verifier_service.app.solver import verify_payload


def test_deployment_without_qa_is_sat_violation():
    outcome = verify_payload(
        {
            "facts": {"deploymentGatePresent": True, "qaApprovalPresent": False},
            "constraints": [
                {
                    "id": "deployment_requires_qa",
                    "severity": "HIGH",
                    "expr": {
                        "op": "IMPLIES",
                        "if": {"field": "deploymentGatePresent", "op": "==", "value": True},
                        "then": {"field": "qaApprovalPresent", "op": "==", "value": True},
                    },
                }
            ],
            "query": {
                "op": "AND",
                "args": [
                    {"field": "deploymentGatePresent", "op": "==", "value": True},
                    {"field": "qaApprovalPresent", "op": "==", "value": False},
                ],
            },
            "options": {"timeoutMs": 1000},
        },
        1000,
        5000,
    )
    assert outcome.result == "SAT"
    assert outcome.risk_level == "HIGH"


def test_fixed_qa_gate_is_unsat_safe():
    outcome = verify_payload(
        {
            "facts": {"deploymentGatePresent": True, "qaApprovalPresent": True},
            "constraints": [
                {
                    "id": "deployment_requires_qa",
                    "severity": "HIGH",
                    "expr": {
                        "op": "IMPLIES",
                        "if": {"field": "deploymentGatePresent", "op": "==", "value": True},
                        "then": {"field": "qaApprovalPresent", "op": "==", "value": True},
                    },
                }
            ],
            "query": {
                "op": "AND",
                "args": [
                    {"field": "deploymentGatePresent", "op": "==", "value": True},
                    {"field": "qaApprovalPresent", "op": "==", "value": False},
                ],
            },
            "options": {"timeoutMs": 1000},
        },
        1000,
        5000,
    )
    assert outcome.result == "UNSAT"
