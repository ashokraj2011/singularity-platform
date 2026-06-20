import pytest
from fastapi import HTTPException

from context_api_service.app.config import settings
from context_api_service.app.internal_mcp import (
    OperationalToolGrantRequest,
    mint_operational_tool_grant,
)


SECRET = "test-operational-tool-grant-secret-1234567890"
SERVICE_TOKEN = "test-context-service-token"


def _finish_request(approval_status: str = "APPROVED") -> OperationalToolGrantRequest:
    return OperationalToolGrantRequest(
        toolName="finish_work_branch",
        args={"message": "finish", "push": True, "remote": "origin"},
        runContext={
            "traceId": "trace-1",
            "workflowInstanceId": "wf-1",
            "nodeId": "git-push-1",
        },
        workflowPolicy={"nodeType": "GIT_PUSH", "approvalStatus": approval_status},
    )


@pytest.mark.asyncio
async def test_operational_grant_mints_finish_work_branch_with_approved_gate(monkeypatch):
    monkeypatch.setattr(settings, "iam_service_token", SERVICE_TOKEN)
    monkeypatch.setenv("CF_TOOL_GRANT_ENABLED", "true")
    monkeypatch.setenv("TOOL_GRANT_SIGNING_SECRET", SECRET)

    response = await mint_operational_tool_grant(_finish_request(), x_service_token=SERVICE_TOKEN)

    assert response["grantEnabled"] is True
    assert response["toolName"] == "finish_work_branch"
    assert response["phase"] == "FINALIZE"
    assert response["grant"]["toolName"] == "finish_work_branch"
    assert response["grant"]["traceId"] == "trace-1"
    assert response["grant"]["sig"]


@pytest.mark.asyncio
async def test_operational_grant_refuses_finish_work_branch_without_approval(monkeypatch):
    monkeypatch.setattr(settings, "iam_service_token", SERVICE_TOKEN)
    monkeypatch.setenv("CF_TOOL_GRANT_ENABLED", "true")
    monkeypatch.setenv("TOOL_GRANT_SIGNING_SECRET", SECRET)

    with pytest.raises(HTTPException) as exc:
        await mint_operational_tool_grant(_finish_request("NOT_REQUIRED"), x_service_token=SERVICE_TOKEN)

    assert exc.value.status_code == 403
    assert "approved workflow approval gate" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_operational_grant_refuses_run_python_network_without_node_policy(monkeypatch):
    monkeypatch.setattr(settings, "iam_service_token", SERVICE_TOKEN)
    monkeypatch.setenv("CF_TOOL_GRANT_ENABLED", "true")
    monkeypatch.setenv("TOOL_GRANT_SIGNING_SECRET", SECRET)

    request = OperationalToolGrantRequest(
        toolName="run_python",
        args={"code": "print(1)", "allow_network": True},
        runContext={
            "traceId": "trace-2",
            "workflowInstanceId": "wf-1",
            "nodeId": "run-python-1",
        },
        workflowPolicy={"nodeType": "RUN_PYTHON", "allowNetwork": False},
    )

    with pytest.raises(HTTPException) as exc:
        await mint_operational_tool_grant(request, x_service_token=SERVICE_TOKEN)

    assert exc.value.status_code == 403
    assert "network access" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_operational_grant_returns_none_when_minting_disabled(monkeypatch):
    monkeypatch.setattr(settings, "iam_service_token", SERVICE_TOKEN)
    monkeypatch.setenv("CF_TOOL_GRANT_ENABLED", "false")
    monkeypatch.setenv("TOOL_GRANT_SIGNING_SECRET", SECRET)

    response = await mint_operational_tool_grant(_finish_request(), x_service_token=SERVICE_TOKEN)

    assert response["grantEnabled"] is False
    assert response["grant"] is None
