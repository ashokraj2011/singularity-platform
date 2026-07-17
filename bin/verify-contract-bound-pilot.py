#!/usr/bin/env python3
"""Verify durable idea-to-check-in evidence for one real Synthesis initiative."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def request_json(base_url: str, path: str, token: str | None = None, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    headers = {"accept": "application/json", "user-agent": "singularity-contract-bound-pilot"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = None
    method = "GET"
    if body is not None:
        method = "POST"
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            content = response.read().decode("utf-8", "replace")
            return response.status, json.loads(content) if content else {}
    except urllib.error.HTTPError as error:
        content = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(content) if content else {}
        except json.JSONDecodeError:
            return error.code, {"message": content}


def credentials() -> tuple[str, str]:
    config_path = Path(__file__).resolve().parents[1] / ".singularity/config.local.json"
    try:
        identity = json.loads(config_path.read_text()).get("identity", {})
    except (OSError, json.JSONDecodeError):
        identity = {}
    return (
        os.getenv("IAM_BOOTSTRAP_USERNAME") or str(identity.get("bootstrapEmail") or "admin@singularity.local"),
        os.getenv("IAM_BOOTSTRAP_PASSWORD") or str(identity.get("bootstrapPassword") or "Admin1234!"),
    )


def main() -> int:
    email, password = credentials()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", default=os.getenv("PILOT_PROJECT_ID"), required=not bool(os.getenv("PILOT_PROJECT_ID")))
    parser.add_argument("--base-url", default=os.getenv("PLATFORM_WEB_BASE_URL", "http://localhost:5180"))
    parser.add_argument("--iam-url", default=os.getenv("IAM_URL", "http://localhost:8100"))
    parser.add_argument("--email", default=email)
    parser.add_argument("--password", default=password)
    parser.add_argument("--report-only", action="store_true", help="Print incomplete evidence without returning a failure status.")
    args = parser.parse_args()

    status, login = request_json(args.iam_url, "/api/v1/auth/local/login", body={"email": args.email, "password": args.password})
    token = login.get("access_token")
    if status != 200 or not isinstance(token, str):
        print(f"FAIL IAM login returned HTTP {status}: {login.get('message') or login}", file=sys.stderr)
        return 2

    status, readiness = request_json(args.base_url, f"/api/workgraph/studio/projects/{args.project_id}/pilot-readiness", token)
    if status != 200:
        print(f"FAIL pilot evidence returned HTTP {status}: {readiness.get('message') or readiness}", file=sys.stderr)
        return 2

    print(f"Contract-bound pilot: {readiness.get('score', 0)}/100")
    for check in readiness.get("checks", []):
        marker = "OK  " if check.get("ok") else "MISS"
        print(f"{marker} {check.get('label', check.get('key'))}")
        if not check.get("ok") and check.get("fixRoute"):
            print(f"     {args.base_url.rstrip('/')}{check['fixRoute']}")
    metrics = readiness.get("metrics", {})
    print("Metrics:", json.dumps(metrics, separators=(",", ":"), sort_keys=True))
    if readiness.get("ready"):
        print(f"PASS evidence is complete: {args.base_url.rstrip('/')}/synthesis/pilot?projectId={args.project_id}")
        return 0
    print("INCOMPLETE durable proof obligations remain.")
    return 0 if args.report_only else 1


if __name__ == "__main__":
    raise SystemExit(main())
