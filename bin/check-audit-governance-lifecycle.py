#!/usr/bin/env python3
"""Verify audit-governance side stack and Platform Web audit proxy.

Audit-governance is optional/remote-capable in the core Docker topology. Run
this when the audit side stack is intentionally enabled, e.g.
`./singularity.sh up --profile audit`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def request_json(
    base_url: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: float = 10,
) -> tuple[int, dict[str, Any]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", "user-agent": "singularity-audit-governance-smoke"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            text = res.read().decode("utf-8", "replace")
            return res.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text) if text else {}
        except json.JSONDecodeError:
            parsed = {"message": text}
        return exc.code, parsed


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def short_error(body: dict[str, Any]) -> str:
    error = body.get("error") if isinstance(body.get("error"), dict) else {}
    return str(error.get("message") or body.get("message") or body.get("error") or body)[:500]


def env_file_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        current_key, value = line.split("=", 1)
        current_key = current_key.removeprefix("export ").strip()
        if current_key != key:
            continue
        return value.strip().strip("\"'")
    return None


def configured_audit_token() -> str:
    return (
        os.getenv("AUDIT_GOV_SERVICE_TOKEN", "").strip()
        or env_file_value(Path(".env"), "AUDIT_GOV_SERVICE_TOKEN")
        or env_file_value(Path("audit-governance-service/.env"), "AUDIT_GOV_SERVICE_TOKEN")
        or "dev-audit-gov-service-token"
    )


def configured_identity() -> tuple[str, str]:
    try:
        identity = json.loads(Path(".singularity/config.local.json").read_text()).get("identity", {})
    except Exception:
        identity = {}
    email = (
        os.getenv("SINGULARITY_SMOKE_EMAIL", "").strip()
        or str(identity.get("bootstrapEmail") or "").strip()
        or "admin@singularity.local"
    )
    password = (
        os.getenv("SINGULARITY_SMOKE_PASSWORD", "").strip()
        or str(identity.get("bootstrapPassword") or "").strip()
        or "Admin1234!"
    )
    return email, password


def platform_caller_token(platform_url: str, explicit_token: str | None = None) -> str:
    if explicit_token:
        return explicit_token
    email, password = configured_identity()
    status, login = request_json(
        platform_url,
        "POST",
        "/api/iam/auth/local/login",
        {"email": email, "password": password},
        timeout=10,
    )
    token = str(login.get("access_token") or login.get("accessToken") or "")
    require(status == 200 and token, f"Platform Web IAM login failed for audit proxy smoke: HTTP {status} {short_error(login)}")
    return token


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-url", default="http://localhost:8500")
    parser.add_argument("--platform-url", default="http://localhost:5180")
    parser.add_argument("--token", default=None)
    parser.add_argument("--caller-token", default=None, help="User JWT for the Platform Web proxy; defaults to bootstrap IAM login")
    args = parser.parse_args()
    token = args.token or configured_audit_token()

    failures = 0
    try:
        status, health = request_json(args.audit_url, "GET", "/health")
        require(status == 200, f"audit-governance health failed: HTTP {status} {short_error(health)}")
        require(health.get("service") == "audit-governance-service", "health response did not identify audit-governance-service")
        print("OK   reached audit-governance service")

        status, strict = request_json(args.audit_url, "GET", "/healthz/strict")
        require(status == 200, f"audit-governance strict health failed: HTTP {status} {short_error(strict)}")
        require(strict.get("ok") is True, "strict health did not return ok=true")
        print("OK   verified audit-governance DB/schema invariants")

        timestamp = int(time.time())
        trace_id = f"singularity-audit-smoke-{timestamp}"
        event = {
            "trace_id": trace_id,
            "source_service": "platform-smoke",
            "kind": "platform.audit.smoke",
            "subject_type": "DoctorSmoke",
            "subject_id": trace_id,
            "actor_id": "singularity-doctor",
            "capability_id": "platform.audit",
            "severity": "info",
            "payload": {"source": "bin/check-audit-governance-lifecycle.py", "timestamp": timestamp},
        }
        caller_token = platform_caller_token(args.platform_url, args.caller_token)
        print("OK   verified Platform Web proxy caller authorization")

        status, ingested = request_json(args.platform_url, "POST", "/api/audit-gov/events", event, token=caller_token)
        require(status == 201, f"Platform Web audit event ingest failed: HTTP {status} {short_error(ingested)}")
        event_id = str(ingested.get("id") or "")
        require(event_id, "audit ingest response did not include event id")
        print(f"OK   ingested audit event through Platform Web proxy {event_id}")

        status, timeline = request_json(
            args.platform_url,
            "GET",
            f"/api/audit-gov/audit/timeline?trace_id={urllib.parse.quote(trace_id)}&limit=5",
            token=caller_token,
        )
        require(status == 200, f"Platform Web audit timeline query failed: HTTP {status} {short_error(timeline)}")
        items = timeline.get("items")
        require(isinstance(items, list) and any(isinstance(item, dict) and item.get("id") == event_id for item in items), "timeline did not include ingested event")
        print("OK   queried ingested audit event through Platform Web proxy")

        status, direct = request_json(args.audit_url, "GET", f"/api/v1/audit/events/{urllib.parse.quote(event_id)}", token=token)
        require(status == 200, f"direct audit event lookup failed: HTTP {status} {short_error(direct)}")
        require(direct.get("id") == event_id and direct.get("trace_id") == trace_id, "direct event lookup did not match ingested event")
        print("OK   verified audit event persisted in audit-governance")
    except Exception as exc:
        failures += 1
        print(f"FAIL {exc}", file=sys.stderr)

    if failures:
        print(f"\n{failures} audit-governance lifecycle smoke check(s) failed.", file=sys.stderr)
        return 1
    print("\nAudit-governance lifecycle smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
