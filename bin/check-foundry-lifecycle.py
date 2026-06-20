#!/usr/bin/env python3
"""Validate and generate a Code Foundry run through Platform Web.

This uses the same `/api/codegen` proxy that the unified `/foundry` UI uses.
It stays on the deterministic greenfield path and does not call LLM patching or
verification, so it is safe for the core stack.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_SPEC = ROOT / "singularity-code-foundry/apps/code-foundry-api/examples/eligibility-service.express.yaml"


def request_json(
    base_url: str,
    method: str,
    path: str,
    body: dict[str, Any] | str | None = None,
    content_type: str = "application/json",
    headers: dict[str, str] | None = None,
    token: str | None = None,
    timeout: float = 20,
) -> tuple[int, dict[str, Any]]:
    if isinstance(body, str):
        data = body.encode("utf-8")
    elif body is None:
        data = None
    else:
        data = json.dumps(body).encode("utf-8")
    req_headers = {
        "content-type": content_type,
        "user-agent": "singularity-foundry-lifecycle-smoke",
    }
    if token:
        # The Platform Web proxy verifies this caller IAM token, then forwards
        # the user identity to Workgraph's code generation routes.
        req_headers["authorization"] = f"Bearer {token}"
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=data, method=method, headers=req_headers)
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
    return str(error.get("message") or body.get("message") or body.get("code") or body)[:500]


def bootstrap_credentials() -> tuple[str, str]:
    config_path = Path(__file__).resolve().parents[1] / ".singularity/config.local.json"
    try:
        identity = json.loads(config_path.read_text()).get("identity", {})
    except (OSError, json.JSONDecodeError):
        identity = {}
    return (
        str(identity.get("bootstrapEmail") or "admin@singularity.local"),
        str(identity.get("bootstrapPassword") or "Admin1234!"),
    )


def login(iam_url: str, email: str, password: str) -> str:
    status, body = request_json(iam_url, "POST", "/api/v1/auth/local/login", {"email": email, "password": password})
    require(status == 200, f"IAM login failed: HTTP {status} {short_error(body)}")
    token = body.get("access_token")
    require(isinstance(token, str) and token, "IAM login response did not include access_token")
    return token


def smoke_spec(timestamp: int) -> str:
    raw = EXAMPLE_SPEC.read_text(encoding="utf-8")
    return (
        raw
        .replace("id: eligibility-service-express-spec", f"id: singularity-foundry-smoke-{timestamp}")
        .replace("name: Eligibility Service (Express)", f"name: Singularity Foundry Smoke {timestamp}")
        .replace("version: 1.0.0", f"version: 1.0.{timestamp}", 1)
    )


def main() -> int:
    default_email, default_password = bootstrap_credentials()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--iam-url", default="http://localhost:8100")
    parser.add_argument("--email", default=default_email)
    parser.add_argument("--password", default=default_password)
    args = parser.parse_args()

    failures = 0
    try:
        token = login(args.iam_url, args.email, args.password)
        print("OK   authenticated with IAM")

        timestamp = int(time.time())
        spec = smoke_spec(timestamp)

        status, health = request_json(args.base_url, "GET", "/api/codegen/runs?take=1", token=token)
        require(status == 200, f"Foundry proxy/list runs failed: HTTP {status} {short_error(health)}")
        require(isinstance(health.get("items"), list), "Foundry run list response did not include items")
        print("OK   reached Foundry through Platform Web proxy")

        status, validated = request_json(args.base_url, "POST", "/api/codegen/spec/validate", spec, "application/yaml", token=token)
        require(status == 200, f"Foundry spec validate failed: HTTP {status} {short_error(validated)}")
        require(validated.get("valid") is True, "Foundry spec validate did not return valid=true")
        require(isinstance(validated.get("specHash"), str) and isinstance(validated.get("irHash"), str), "validate response missing hashes")
        print("OK   validated smoke service spec")

        output_dir = f"/tmp/singularity-foundry-smoke-{timestamp}"
        status, generated = request_json(
            args.base_url,
            "POST",
            "/api/codegen/generate",
            spec,
            "application/yaml",
            headers={"x-output-dir": output_dir, "x-actor-id": "singularity-foundry-smoke"},
            token=token,
            timeout=30,
        )
        require(status == 200, f"Foundry generate failed: HTTP {status} {short_error(generated)}")
        run_id = str(generated.get("runId") or "")
        require(run_id, "generate response did not include runId")
        require(generated.get("outputPath") == output_dir, "generate response did not preserve outputPath")
        require(int(generated.get("generatedFileCount") or 0) > 0, "generate response had no generated files")
        print(f"OK   generated Foundry run {run_id}")

        status, run = request_json(args.base_url, "GET", f"/api/codegen/runs/{urllib.parse.quote(run_id)}", token=token)
        require(status == 200, f"Foundry run detail failed: HTTP {status} {short_error(run)}")
        require(run.get("id") == run_id and run.get("status") == "GENERATED", "run detail did not reflect generated run")
        spec_id = str(run.get("specId") or "")
        require(spec_id, "run detail did not include specId")
        counts = run.get("counts") if isinstance(run.get("counts"), dict) else {}
        require(int(counts.get("artifacts") or 0) > 0, "run detail did not count generated artifacts")
        print("OK   fetched Foundry run detail")

        status, history = request_json(args.base_url, "GET", f"/api/codegen/specs/{urllib.parse.quote(spec_id)}/history", token=token)
        require(status == 200, f"Foundry spec history failed: HTTP {status} {short_error(history)}")
        events = history.get("items")
        require(isinstance(events, list) and events, "spec history response did not include lifecycle events")
        states = {event.get("toState") for event in events if isinstance(event, dict)}
        require({"VALIDATED", "POLICY_APPROVED", "FROZEN"}.issubset(states), f"spec history missing expected lifecycle states: {sorted(str(state) for state in states)}")
        print("OK   fetched Foundry spec lifecycle history")

        status, artifacts_body = request_json(args.base_url, "GET", f"/api/codegen/runs/{urllib.parse.quote(run_id)}/artifacts", token=token)
        require(status == 200, f"Foundry artifact list failed: HTTP {status} {short_error(artifacts_body)}")
        artifacts = artifacts_body.get("items")
        require(isinstance(artifacts, list) and artifacts, "artifact list was empty")
        first_path = next((item.get("path") for item in artifacts if isinstance(item, dict) and isinstance(item.get("path"), str)), None)
        require(isinstance(first_path, str) and first_path, "artifact list did not include a path")
        print("OK   listed Foundry artifacts")

        status, file_body = request_json(args.base_url, "GET", f"/api/codegen/runs/{urllib.parse.quote(run_id)}/file?path={urllib.parse.quote(first_path)}", token=token)
        require(status == 200, f"Foundry file read failed: HTTP {status} {short_error(file_body)}")
        require(file_body.get("path") == first_path and isinstance(file_body.get("content"), str), "file read response was malformed")
        print("OK   read generated Foundry file content")

        status, receipt = request_json(args.base_url, "GET", f"/api/codegen/runs/{urllib.parse.quote(run_id)}/receipt", token=token)
        require(status == 200, f"Foundry receipt failed: HTTP {status} {short_error(receipt)}")
        require(isinstance(receipt.get("receiptHash"), str) and receipt.get("receiptHash"), "receipt response missing receiptHash")
        print("OK   fetched Foundry receipt")

        status, repos = request_json(args.base_url, "GET", "/api/codegen/repos", token=token)
        require(status == 200 and isinstance(repos.get("items"), list), f"Foundry repos list failed: HTTP {status} {short_error(repos)}")
        status, plans = request_json(args.base_url, "GET", "/api/codegen/change-plans", token=token)
        require(status == 200 and isinstance(plans.get("items"), list), f"Foundry change plans list failed: HTTP {status} {short_error(plans)}")
        print("OK   fetched Foundry read-only indexes")
    except Exception as exc:
        failures += 1
        print(f"FAIL {exc}", file=sys.stderr)

    if failures:
        print(f"\n{failures} Foundry lifecycle smoke check(s) failed.", file=sys.stderr)
        return 1
    print("\nFoundry lifecycle smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
