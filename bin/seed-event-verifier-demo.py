#!/usr/bin/env python3
"""Bootstrap the event-driven Verifier agent workflow through the public APIs.

This is intentionally an API bootstrap, not a direct Prisma seed:
  * the Verifier agent profile is owned by agent-runtime authorization;
  * the read-only skill file is persisted as an uploaded document source;
  * WorkGraph receives the same user JWT the browser would send.

The command is idempotent. By default it creates/updates the agent, workflow,
routing policy, and event trigger. Pass --simulate to fire one sample event and
create/start a demo WorkItem run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_CAPABILITY_ID = "11111111-2222-3333-4444-555555555555"
DEFAULT_EVENT_TYPE = "VERIFIER_DOCUMENT_SUBMITTED"
DEFAULT_WORK_ITEM_TYPE = "DOCUMENT_REVIEW"
DEFAULT_WORKFLOW_TYPE = "VERIFIER_DOCUMENT_REVIEW"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def config_identity() -> dict[str, Any]:
    path = repo_root() / ".singularity" / "config.local.json"
    try:
        data = json.loads(path.read_text())
        identity = data.get("identity")
        return identity if isinstance(identity, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def default_email_password() -> tuple[str, str]:
    identity = config_identity()
    email = (
        os.getenv("IAM_BOOTSTRAP_USERNAME")
        or os.getenv("LOCAL_SUPER_ADMIN_EMAIL")
        or str(identity.get("bootstrapEmail") or "admin@singularity.local")
    )
    password = (
        os.getenv("IAM_BOOTSTRAP_PASSWORD")
        or os.getenv("LOCAL_SUPER_ADMIN_PASSWORD")
        or str(identity.get("bootstrapPassword") or "Admin1234!")
    )
    return email, password


def normalize_iam_url(value: str) -> str:
    base = value.rstrip("/")
    if base.endswith("/api/v1"):
        return base
    if base.endswith("/api"):
        return f"{base}/v1"
    return f"{base}/api/v1"


def json_request(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: int = 20,
) -> tuple[int, Any, str]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"accept": "application/json"}
    if body is not None:
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = Request(url, data=payload, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8", "replace")
            return res.status, parse_json(raw), raw
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        return exc.code, parse_json(raw), raw
    except (OSError, TimeoutError, URLError) as exc:
        raise RuntimeError(f"{method} {url} failed: {exc}") from exc


def parse_json(raw: str) -> Any:
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def unwrap(body: Any) -> Any:
    if isinstance(body, dict) and "data" in body:
        return body["data"]
    return body


def message(body: Any, raw: str) -> str:
    if isinstance(body, dict):
        for key in ("message", "detail", "error"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value[:700]
            if isinstance(value, dict):
                nested = value.get("message") or value.get("detail")
                if isinstance(nested, str) and nested:
                    return nested[:700]
    return (raw or str(body))[:700]


def login(iam_url: str, email: str, password: str) -> str:
    status, body, raw = json_request(
        "POST",
        f"{normalize_iam_url(iam_url)}/auth/local/login",
        {"email": email, "password": password},
        timeout=15,
    )
    if status != 200:
        raise RuntimeError(f"IAM login failed ({status}): {message(body, raw)}")
    token = body.get("access_token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("IAM login response did not include access_token")
    return token


def setup(args: argparse.Namespace, token: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "agentName": args.agent_name,
        "eventTypeKey": args.event_type,
        "workItemTypeKey": args.work_item_type,
        "workflowTypeKey": args.workflow_type,
        "llmConnectionAlias": args.llm_alias,
        "reviewRequired": not args.no_review,
        "emitTransport": args.emit_transport,
    }
    if args.capability_id:
        body["capabilityId"] = args.capability_id
    if args.workflow_name:
        body["workflowName"] = args.workflow_name
    if args.sqs_queue_url:
        body["sqsQueueUrl"] = args.sqs_queue_url

    status, payload, raw = json_request(
        "POST",
        f"{args.workgraph_url.rstrip('/')}/api/demo/event-verifier/setup",
        body,
        token=token,
        timeout=60,
    )
    if status not in (200, 201):
        raise RuntimeError(f"Verifier setup failed ({status}): {message(payload, raw)}")
    data = unwrap(payload)
    if not isinstance(data, dict):
        raise RuntimeError("Verifier setup returned an invalid response")
    return data


def simulate(args: argparse.Namespace, token: str, capability_id: str) -> dict[str, Any]:
    body = {
        "capabilityId": capability_id,
        "eventTypeKey": args.event_type,
    }
    status, payload, raw = json_request(
        "POST",
        f"{args.workgraph_url.rstrip('/')}/api/demo/event-verifier/simulate",
        body,
        token=token,
        timeout=60,
    )
    if status not in (200, 201):
        raise RuntimeError(f"Verifier event simulation failed ({status}): {message(payload, raw)}")
    data = unwrap(payload)
    if not isinstance(data, dict):
        raise RuntimeError("Verifier event simulation returned an invalid response")
    return data


def ingest_sample(args: argparse.Namespace, token: str, capability_id: str) -> dict[str, Any]:
    body = {
        "workId": args.ingest_work_id,
        "description": args.ingest_description,
        "capabilityName": args.capability_name or capability_id,
        "eventTypeKey": args.event_type,
        "documents": [{
            "label": "Verifier sample design",
            "mediaType": "text/markdown",
            "content": "\n\n".join([
                "# Verifier Sample Design",
                "Requirement: validate a document sent by an external event.",
                "Acceptance criteria: verifier returns APPROVE, REJECT, or SEND_BACK with findings.",
                "Risk: missing test evidence should be called out.",
            ]),
        }],
    }
    status, payload, raw = json_request(
        "POST",
        f"{args.workgraph_url.rstrip('/')}/api/demo/event-verifier/ingest",
        body,
        token=token,
        timeout=60,
    )
    if status not in (200, 201):
        raise RuntimeError(f"Verifier event ingest failed ({status}): {message(payload, raw)}")
    data = unwrap(payload)
    if not isinstance(data, dict):
        raise RuntimeError("Verifier event ingest returned an invalid response")
    return data


def main() -> int:
    email, password = default_email_password()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iam-url", default=os.getenv("IAM_BASE_URL") or "http://localhost:8100")
    parser.add_argument("--workgraph-url", default=os.getenv("WORKGRAPH_API_URL") or "http://localhost:8080")
    parser.add_argument("--email", default=email)
    parser.add_argument("--password", default=password)
    parser.add_argument("--capability-id", default=os.getenv("SEED_EVENT_VERIFIER_CAPABILITY_ID") or os.getenv("SEED_CAPABILITY_ID") or DEFAULT_CAPABILITY_ID)
    parser.add_argument("--agent-name", default=os.getenv("SEED_EVENT_VERIFIER_AGENT_NAME") or "Verifier")
    parser.add_argument("--workflow-name", default=os.getenv("SEED_EVENT_VERIFIER_WORKFLOW_NAME") or "")
    parser.add_argument("--event-type", default=os.getenv("SEED_EVENT_VERIFIER_EVENT_TYPE") or DEFAULT_EVENT_TYPE)
    parser.add_argument("--work-item-type", default=os.getenv("SEED_EVENT_VERIFIER_WORK_ITEM_TYPE") or DEFAULT_WORK_ITEM_TYPE)
    parser.add_argument("--workflow-type", default=os.getenv("SEED_EVENT_VERIFIER_WORKFLOW_TYPE") or DEFAULT_WORKFLOW_TYPE)
    parser.add_argument("--llm-alias", default=os.getenv("SEED_EVENT_VERIFIER_LLM_ALIAS") or "mock")
    parser.add_argument("--emit-transport", choices=["EVENTBUS", "SQS"], default=os.getenv("SEED_EVENT_VERIFIER_EMIT_TRANSPORT") or "EVENTBUS")
    parser.add_argument("--sqs-queue-url", default=os.getenv("SEED_EVENT_VERIFIER_SQS_QUEUE_URL") or "")
    parser.add_argument("--no-review", action="store_true", help="Create the workflow without a human review pause.")
    parser.add_argument("--simulate", action="store_true", help="After setup, simulate one event and print the run URL.")
    parser.add_argument("--ingest-sample", action="store_true", help="After setup, POST the real workId/description/capabilityName event contract.")
    parser.add_argument("--capability-name", default=os.getenv("SEED_EVENT_VERIFIER_CAPABILITY_NAME") or "", help="Capability name/key/id for --ingest-sample; defaults to capability id.")
    parser.add_argument("--ingest-work-id", default=os.getenv("SEED_EVENT_VERIFIER_WORK_ID") or "WRK-EXT-1001")
    parser.add_argument("--ingest-description", default=os.getenv("SEED_EVENT_VERIFIER_DESCRIPTION") or "Validate the incoming design document and return approve, reject, or send-back feedback.")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    try:
        token = login(args.iam_url, args.email, args.password)
        data = setup(args, token)
        capability_id = str(data.get("capabilityId") or args.capability_id)
        workflow = data.get("workflow") if isinstance(data.get("workflow"), dict) else {}
        agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
        trigger = data.get("eventTrigger") if isinstance(data.get("eventTrigger"), dict) else {}
        if not args.quiet:
            print("OK   event Verifier workflow bootstrapped")
            print(f"     capability: {capability_id}")
            print(f"     agent:      {agent.get('name', args.agent_name)} ({agent.get('id', 'unknown')})")
            print(f"     workflow:   {workflow.get('name', args.workflow_name or 'Event Verifier')} ({workflow.get('id', 'unknown')})")
            print(f"     trigger:    {trigger.get('eventTypeKey', args.event_type)} ({trigger.get('id', 'unknown')})")
            if workflow.get("designerUrl"):
                print(f"     designer:   {workflow.get('designerUrl')}")

        if args.simulate:
            result = simulate(args, token, capability_id)
            if not args.quiet:
                print("OK   sample event simulated")
                print(f"     workItem:   {result.get('workItem', {}).get('workCode') if isinstance(result.get('workItem'), dict) else 'unknown'}")
                print(f"     run:        {result.get('runUrl') or result.get('workflowInstanceId') or 'not started'}")
        if args.ingest_sample:
            result = ingest_sample(args, token, capability_id)
            if not args.quiet:
                print("OK   work event ingested")
                print(f"     workId:     {result.get('workId', args.ingest_work_id)}")
                print(f"     workItem:   {result.get('workItem', {}).get('workCode') if isinstance(result.get('workItem'), dict) else 'unknown'}")
                print(f"     run:        {result.get('runUrl') or result.get('workflowInstanceId') or 'not started'}")
                callbacks = result.get("callbackEvents")
                if isinstance(callbacks, list):
                    print(f"     callbacks:  {', '.join(str(item) for item in callbacks[:6])}")
    except Exception as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
