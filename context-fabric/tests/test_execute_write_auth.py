from fastapi import FastAPI
from fastapi.testclient import TestClient

from context_api_service.app import execute as execute_mod
from context_api_service.app import main as main_mod


def _execute_client(monkeypatch, *, production: bool = True) -> TestClient:
    monkeypatch.setattr(execute_mod, "is_production_class_env", lambda: production)
    monkeypatch.setattr(execute_mod.settings, "iam_service_token", "cf-service-token")
    app = FastAPI()
    app.include_router(execute_mod.router)
    return TestClient(app, raise_server_exceptions=False)


def test_execute_write_endpoints_require_service_token_in_production(monkeypatch):
    client = _execute_client(monkeypatch, production=True)
    cases = [
        ("/execute", {"task": "hello"}),
        ("/execute/resume", {"cf_call_id": "call-1", "decision": "approved"}),
        ("/api/v1/execute-governed", {"stage_key": "develop"}),
        ("/api/v1/execute-governed-turn", {"stage_key": "develop"}),
        ("/api/v1/execute-governed-stage", {"stage_key": "develop"}),
        ("/api/v1/execute-governed-single-turn", {"task": "hello"}),
    ]

    for path, body in cases:
        response = client.post(path, json=body)
        assert response.status_code == 401, path
        assert response.json()["detail"] == "invalid service token"


def test_execute_write_gate_accepts_service_token_in_production(monkeypatch):
    monkeypatch.setattr(execute_mod, "is_production_class_env", lambda: True)
    monkeypatch.setattr(execute_mod.settings, "iam_service_token", "cf-service-token")

    execute_mod.check_execute_service_token("cf-service-token")


def test_execute_write_gate_remains_open_in_local_development(monkeypatch):
    monkeypatch.setattr(execute_mod, "is_production_class_env", lambda: False)
    monkeypatch.setattr(execute_mod.settings, "iam_service_token", "cf-service-token")

    execute_mod.check_execute_service_token(None)


def test_deprecated_chat_respond_requires_service_token_in_production(monkeypatch):
    monkeypatch.setattr(execute_mod, "is_production_class_env", lambda: True)
    monkeypatch.setattr(execute_mod.settings, "iam_service_token", "cf-service-token")

    client = TestClient(main_mod.app, raise_server_exceptions=False)
    response = client.post("/chat/respond", json={"session_id": "s1", "message": "hello"})

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid service token"
