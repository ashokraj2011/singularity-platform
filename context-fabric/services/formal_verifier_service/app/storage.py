from __future__ import annotations

import json
import uuid
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .config import settings
from .solver import SolverOutcome, stable_hash


def db_enabled() -> bool:
    return bool(settings.database_url.strip())


def ensure_schema() -> None:
    if not db_enabled():
        return
    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        conn.execute("CREATE SCHEMA IF NOT EXISTS formal_verification")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS formal_verification.verification_requests (
              id UUID PRIMARY KEY,
              scope TEXT NOT NULL,
              requested_by TEXT,
              capability_id TEXT,
              workflow_id TEXT,
              workflow_instance_id TEXT,
              artifact_refs JSONB NOT NULL DEFAULT '[]',
              query JSONB NOT NULL DEFAULT '{}',
              options JSONB NOT NULL DEFAULT '{}',
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS formal_verification.verification_results (
              id UUID PRIMARY KEY,
              request_id UUID NOT NULL REFERENCES formal_verification.verification_requests(id) ON DELETE CASCADE,
              result TEXT NOT NULL,
              risk_level TEXT NOT NULL,
              counterexample JSONB,
              explanation TEXT NOT NULL,
              recommendations JSONB NOT NULL DEFAULT '[]',
              solver_name TEXT NOT NULL,
              solver_duration_ms INTEGER NOT NULL,
              solver_timeout BOOLEAN NOT NULL DEFAULT false,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS formal_verification.constraints (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              source_artifact_id TEXT,
              source_artifact_type TEXT,
              expression JSONB NOT NULL,
              description TEXT,
              severity TEXT,
              tags TEXT[] NOT NULL DEFAULT '{}',
              version INTEGER NOT NULL DEFAULT 1,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS formal_verification.verification_receipts (
              id UUID PRIMARY KEY,
              request_id UUID NOT NULL REFERENCES formal_verification.verification_requests(id) ON DELETE CASCADE,
              result_id UUID NOT NULL REFERENCES formal_verification.verification_results(id) ON DELETE CASCADE,
              artifact_hash TEXT NOT NULL,
              constraint_hash TEXT NOT NULL,
              solver_trace_hash TEXT NOT NULL,
              signed_by TEXT,
              signature TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )


def persist_verification(payload: dict[str, Any], outcome: SolverOutcome) -> dict[str, str]:
    request_id = str(uuid.uuid4())
    result_id = str(uuid.uuid4())
    receipt_id = str(uuid.uuid4())
    if not db_enabled():
        return {"requestId": request_id, "resultId": result_id, "receiptId": receipt_id}
    artifact_refs = payload.get("artifactRefs") if isinstance(payload.get("artifactRefs"), list) else []
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    scope = str(payload.get("scope") or "GENERAL")
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as conn:
        conn.execute(
            """
            INSERT INTO formal_verification.verification_requests
              (id, scope, requested_by, capability_id, workflow_id, workflow_instance_id, artifact_refs, query, options)
            VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
            """,
            (
                request_id,
                scope,
                metadata.get("requestedBy") or metadata.get("actorId"),
                metadata.get("capabilityId") or payload.get("capabilityId"),
                metadata.get("workflowId") or payload.get("workflowId"),
                metadata.get("workflowInstanceId") or payload.get("workflowInstanceId"),
                json.dumps(artifact_refs),
                json.dumps(payload.get("query") if isinstance(payload.get("query"), dict) else {}),
                json.dumps(payload.get("options") if isinstance(payload.get("options"), dict) else {}),
            ),
        )
        conn.execute(
            """
            INSERT INTO formal_verification.verification_results
              (id, request_id, result, risk_level, counterexample, explanation, recommendations,
               solver_name, solver_duration_ms, solver_timeout)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s, %s, %s)
            """,
            (
                result_id,
                request_id,
                outcome.result,
                outcome.risk_level,
                json.dumps(outcome.counterexample),
                outcome.explanation,
                json.dumps(outcome.recommendations),
                "Z3",
                outcome.duration_ms,
                outcome.timeout,
            ),
        )
        conn.execute(
            """
            INSERT INTO formal_verification.verification_receipts
              (id, request_id, result_id, artifact_hash, constraint_hash, solver_trace_hash, signed_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                receipt_id,
                request_id,
                result_id,
                stable_hash(artifact_refs),
                outcome.constraint_hash,
                outcome.solver_trace_hash,
                settings.service_name,
            ),
        )
    return {"requestId": request_id, "resultId": result_id, "receiptId": receipt_id}
