from fastapi import FastAPI
from fastapi.testclient import TestClient

from context_api_service.app import execute as execute_mod


def _client(monkeypatch, *, production: bool = True) -> TestClient:
    monkeypatch.setattr(execute_mod, "is_production_class_env", lambda: production)
    monkeypatch.setattr(execute_mod.settings, "iam_service_token", "cf-service-token")
    monkeypatch.setattr(execute_mod.call_log, "list_recent", lambda limit: [{"id": "call-1"}])
    monkeypatch.setattr(execute_mod.call_log, "get_by_id", lambda call_id: {"id": call_id})
    monkeypatch.setattr(
        execute_mod.events_store,
        "list_by_trace",
        lambda trace_id, since_id=None, since_timestamp=None, limit=500, tenant_id=None: [
            {"id": "event-1", "trace_id": trace_id, "timestamp": "2026-06-19T00:00:00Z"}
        ],
    )
    monkeypatch.setattr(execute_mod.events_store, "get_by_id", lambda event_id: {"id": event_id})

    app = FastAPI()
    app.include_router(execute_mod.router)
    return TestClient(app, raise_server_exceptions=False)


def test_execute_read_endpoints_require_service_token_in_production(monkeypatch):
    client = _client(monkeypatch, production=True)

    for path in [
        "/execute/calls",
        "/execute/calls/call-1",
        "/execute/events?trace_id=trace-1",
        "/execute/events/event-1",
    ]:
        response = client.get(path)
        assert response.status_code == 401, path
        assert response.json()["detail"] == "invalid service token"


def test_execute_read_endpoints_accept_service_token_in_production(monkeypatch):
    client = _client(monkeypatch, production=True)

    response = client.get("/execute/events?trace_id=trace-1", headers={"X-Service-Token": "cf-service-token"})

    assert response.status_code == 200
    assert response.json()["events"][0]["id"] == "event-1"


def test_execute_read_endpoints_remain_open_in_local_development(monkeypatch):
    client = _client(monkeypatch, production=False)

    response = client.get("/execute/calls")

    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == "call-1"
