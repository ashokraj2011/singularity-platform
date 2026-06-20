#!/usr/bin/env python3
"""Create, update, chat in, and abandon a Workbench session through Platform Web.

This intentionally goes through the unified Platform Web proxy instead of
calling workgraph-api directly, because that is the path the migrated UI uses.
It avoids snapshot/stage execution so the check does not require GitHub, MCP, or
LLM services.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
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
    headers = {"content-type": "application/json", "user-agent": "singularity-workbench-lifecycle-smoke"}
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


def unwrap(body: dict[str, Any]) -> Any:
    return body.get("data") if body.get("success") is True and "data" in body else body


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def short_error(body: dict[str, Any]) -> str:
    error = body.get("error") if isinstance(body.get("error"), dict) else {}
    return str(error.get("message") or body.get("message") or body.get("error") or body)[:500]


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


def first_active_capability(base_url: str, token: str) -> str:
    status, body = request_json(base_url, "GET", "/api/runtime/capabilities", token=token)
    require(status == 200, f"list capabilities failed: HTTP {status} {short_error(body)}")
    data = unwrap(body)
    items = data if isinstance(data, list) else data.get("items") if isinstance(data, dict) else []
    require(isinstance(items, list) and items, "capability list was empty")
    for item in items:
        if isinstance(item, dict) and item.get("status") == "ACTIVE" and isinstance(item.get("id"), str):
            return item["id"]
    raise RuntimeError("no active capability found")


def common_agent_templates(base_url: str, token: str) -> dict[str, str]:
    status, body = request_json(base_url, "GET", "/api/runtime/agents/templates?scope=common&limit=100", token=token)
    require(status == 200, f"list common agent templates failed: HTTP {status} {short_error(body)}")
    data = unwrap(body)
    items = data.get("items") if isinstance(data, dict) else []
    require(isinstance(items, list) and items, "common agent template list was empty")
    by_role: dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict) or item.get("status") != "ACTIVE":
            continue
        role = item.get("roleType")
        template_id = item.get("id")
        if isinstance(role, str) and isinstance(template_id, str):
            by_role.setdefault(role, template_id)
    required = ["ARCHITECT", "DEVELOPER", "QA"]
    missing = [role for role in required if role not in by_role]
    require(not missing, f"missing common agent templates for roles: {', '.join(missing)}")
    return by_role


def main() -> int:
    default_email, default_password = bootstrap_credentials()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--iam-url", default="http://localhost:8100")
    parser.add_argument("--email", default=default_email)
    parser.add_argument("--password", default=default_password)
    args = parser.parse_args()

    session_id = ""
    failures = 0
    try:
        token = login(args.iam_url, args.email, args.password)
        print("OK   authenticated with IAM")

        capability_id = first_active_capability(args.base_url, token)
        print(f"OK   selected capability {capability_id}")
        templates = common_agent_templates(args.base_url, token)
        print("OK   selected common Architect/Developer/QA templates")

        timestamp = int(time.time())
        goal = f"__singularity_workbench_smoke_{timestamp}__ verify unified Workbench lifecycle"
        status, created_body = request_json(args.base_url, "POST", "/workbench/api/blueprint/sessions", {
            "goal": goal,
            "sourceType": "localdir",
            "sourceUri": "/tmp/singularity-workbench-smoke",
            "sourceRef": "main",
            "includeGlobs": ["**/*.md"],
            "excludeGlobs": ["node_modules/**", ".git/**"],
            "capabilityId": capability_id,
            "architectAgentTemplateId": templates["ARCHITECT"],
            "developerAgentTemplateId": templates["DEVELOPER"],
            "qaAgentTemplateId": templates["QA"],
            "gateMode": "manual",
            "snapshotMode": "summary",
            "maxLoopsPerStage": 1,
            "maxTotalSendBacks": 0,
            "maxContextTokens": 4096,
            "maxOutputTokens": 512,
        }, token=token)
        require(status == 201, f"create Workbench session failed: HTTP {status} {short_error(created_body)}")
        created = unwrap(created_body)
        session_id = str(created.get("id") or "")
        require(session_id, "create response did not include id")
        require(created.get("status") == "DRAFT", "created Workbench session was not DRAFT")
        stage_key = created.get("currentStageKey")
        require(isinstance(stage_key, str) and stage_key, "created Workbench session did not expose currentStageKey")
        print(f"OK   created Workbench session {session_id}")

        status, fetched_body = request_json(args.base_url, "GET", f"/workbench/api/blueprint/sessions/{session_id}", token=token)
        require(status == 200, f"fetch Workbench session failed: HTTP {status} {short_error(fetched_body)}")
        fetched = unwrap(fetched_body)
        require(fetched.get("goal") == goal, "fetched Workbench session did not match created goal")
        print("OK   fetched Workbench session")

        status, status_body = request_json(args.base_url, "GET", f"/workbench/api/blueprint/sessions/{session_id}/status", token=token)
        require(status == 200, f"fetch Workbench status failed: HTTP {status} {short_error(status_body)}")
        lite = unwrap(status_body)
        require(lite.get("id") == session_id and lite.get("currentStageKey") == stage_key, "Workbench status did not match session")
        print("OK   fetched lightweight Workbench status")

        status, patched_body = request_json(args.base_url, "PATCH", f"/workbench/api/blueprint/sessions/{session_id}/settings", {
            "reuseUnchangedAttempt": True,
            "maxContextTokens": 8192,
            "maxOutputTokens": 1024,
        }, token=token)
        require(status == 200, f"patch Workbench settings failed: HTTP {status} {short_error(patched_body)}")
        patched = unwrap(patched_body)
        execution_config = patched.get("executionConfig") if isinstance(patched.get("executionConfig"), dict) else {}
        require(execution_config.get("maxContextTokens") == 8192, "settings patch did not persist maxContextTokens")
        require(execution_config.get("maxOutputTokens") == 1024, "settings patch did not persist maxOutputTokens")
        print("OK   patched Workbench runtime settings")

        message = f"Smoke operator note {timestamp}"
        status, posted_body = request_json(
            args.base_url,
            "POST",
            f"/workbench/api/blueprint/sessions/{session_id}/stages/{stage_key}/messages",
            {"role": "operator", "content": message},
            token=token,
        )
        require(status == 200, f"post Workbench stage chat failed: HTTP {status} {short_error(posted_body)}")
        posted = unwrap(posted_body)
        posted_message = posted.get("message") if isinstance(posted.get("message"), dict) else {}
        require(posted_message.get("content") == message, "posted stage chat message did not echo content")

        status, messages_body = request_json(args.base_url, "GET", f"/workbench/api/blueprint/sessions/{session_id}/stages/{stage_key}/messages", token=token)
        require(status == 200, f"list Workbench stage chat failed: HTTP {status} {short_error(messages_body)}")
        messages = unwrap(messages_body).get("items")
        require(isinstance(messages, list) and any(isinstance(item, dict) and item.get("content") == message for item in messages), "stage chat list did not include posted message")
        print("OK   wrote and read Workbench stage chat")

        status, abandoned_body = request_json(args.base_url, "POST", f"/workbench/api/blueprint/sessions/{session_id}/abandon", {}, token=token)
        require(status == 200, f"abandon Workbench session failed: HTTP {status} {short_error(abandoned_body)}")
        abandoned = unwrap(abandoned_body)
        require(abandoned.get("status") == "ABANDONED", "abandon response did not mark session ABANDONED")
        session_id = ""
        print("OK   abandoned temporary Workbench session")
    except Exception as exc:
        failures += 1
        print(f"FAIL {exc}", file=sys.stderr)
    finally:
        if session_id:
            try:
                token = locals().get("token")
                status, body = request_json(args.base_url, "POST", f"/workbench/api/blueprint/sessions/{session_id}/abandon", {}, token=token)
                if status == 200 and unwrap(body).get("status") == "ABANDONED":
                    print(f"OK   cleanup abandoned Workbench session {session_id}")
                else:
                    print(f"WARN cleanup abandon failed for Workbench session {session_id}: HTTP {status} {short_error(body)}", file=sys.stderr)
            except Exception as cleanup_exc:
                print(f"WARN cleanup abandon failed for Workbench session {session_id}: {cleanup_exc}", file=sys.stderr)

    if failures:
        print(f"\n{failures} Workbench lifecycle smoke check(s) failed.", file=sys.stderr)
        return 1
    print("\nWorkbench lifecycle smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
