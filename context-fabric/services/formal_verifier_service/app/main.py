from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from z3 import Solver

from .config import settings
from .solver import ConstraintError, verify_payload
from .storage import db_enabled, ensure_schema, persist_verification


app = FastAPI(title="Singularity Formal Verifier Service", version="0.1.0")


class VerificationRequest(BaseModel):
    scope: str = "GENERAL"
    constraints: list[dict[str, Any]] = Field(default_factory=list)
    query: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    artifactRefs: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    capabilityId: str | None = None
    workflowId: str | None = None
    workflowInstanceId: str | None = None


@app.on_event("startup")
def startup() -> None:
    if settings.formal_verification_enabled:
        ensure_schema()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": settings.service_name,
        "enabled": settings.formal_verification_enabled,
    }


@app.get("/api/v1/verification/status")
def status() -> dict[str, Any]:
    solver_ok = True
    db_ok = True
    db_reason = None
    try:
        Solver()
    except Exception:
        solver_ok = False
    try:
        if settings.formal_verification_enabled:
            ensure_schema()
    except Exception as exc:
        db_ok = False
        db_reason = str(exc)
    if not db_enabled():
        db_ok = False
        db_reason = "DATABASE_URL is not configured"
    state = "Disabled"
    if settings.formal_verification_enabled:
        state = "Enabled" if solver_ok and db_ok else "Solver unavailable" if not solver_ok else "Service unreachable"
    return {
        "enabled": settings.formal_verification_enabled,
        "status": state,
        "solver": {"name": "Z3", "ready": solver_ok},
        "database": {"ready": db_ok, "reason": db_reason},
    }


@app.get("/healthz/strict")
def healthz_strict() -> JSONResponse:
    body = status()
    ok = (not settings.formal_verification_enabled) or (
        body["solver"]["ready"] and body["database"]["ready"]
    )
    return JSONResponse(status_code=200 if ok else 503, content={"ok": ok, "service": settings.service_name, "checks": body})


@app.post("/api/v1/verification/verify")
def verify(req: VerificationRequest) -> dict[str, Any]:
    _require_enabled()
    payload = req.model_dump()
    try:
        outcome = verify_payload(payload, settings.default_timeout_ms, settings.max_timeout_ms)
    except ConstraintError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "INVALID_CONSTRAINT", "message": str(exc), "constraintId": exc.constraint_id},
        ) from exc
    ids = persist_verification(payload, outcome)
    return {
        "requestId": ids["requestId"],
        "resultId": ids["resultId"],
        "receiptId": ids["receiptId"],
        "result": outcome.result,
        "meaning": outcome.meaning,
        "riskLevel": outcome.risk_level,
        "counterexample": outcome.counterexample,
        "explanation": outcome.explanation,
        "recommendations": outcome.recommendations,
        "solver": {
            "name": "Z3",
            "durationMs": outcome.duration_ms,
            "timeout": outcome.timeout,
        },
        "hashes": {
            "constraintHash": outcome.constraint_hash,
            "solverTraceHash": outcome.solver_trace_hash,
        },
    }


@app.post("/api/v1/verification/workflows/analyze")
def analyze_workflow(req: VerificationRequest) -> dict[str, Any]:
    return _analyze(req, default_scope="WORKFLOW_POLICY")


@app.post("/api/v1/verification/agents/analyze")
def analyze_agent(req: VerificationRequest) -> dict[str, Any]:
    return _analyze(req, default_scope="AGENT_PERMISSION")


@app.post("/api/v1/verification/specs/analyze")
def analyze_spec(req: VerificationRequest) -> dict[str, Any]:
    return _analyze(req, default_scope="SPEC_CONSISTENCY")


@app.post("/api/v1/verification/deployment-policies/analyze")
def analyze_deployment_policy(req: VerificationRequest) -> dict[str, Any]:
    return _analyze(req, default_scope="DEPLOYMENT_POLICY")


def _analyze(req: VerificationRequest, default_scope: str) -> dict[str, Any]:
    if not req.scope or req.scope == "GENERAL":
        req.scope = default_scope
    return verify(req)


def _require_enabled() -> None:
    if not settings.formal_verification_enabled:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "FORMAL_VERIFICATION_DISABLED",
                "message": "Formal Verification is disabled at the platform level.",
            },
        )
