#!/usr/bin/env python3
"""Create, edit, verify, and archive a temporary workflow through Platform Web.

This intentionally goes through the unified Platform Web proxy instead of
calling workgraph-api directly, because that is the path the migrated UI uses.
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
    headers = {"content-type": "application/json", "user-agent": "singularity-workflow-lifecycle-smoke"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        method=method,
        headers=headers,
    )
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
    return str(body.get("message") or body.get("error") or body)[:500]


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


def main() -> int:
    default_email, default_password = bootstrap_credentials()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--iam-url", default="http://localhost:8100")
    parser.add_argument("--email", default=default_email)
    parser.add_argument("--password", default=default_password)
    args = parser.parse_args()

    name = f"__singularity_lifecycle_smoke_{int(time.time())}__"
    capability_id = "smoke.lifecycle"
    workflow_id = ""
    work_item_id = ""
    target_id = ""
    run_id = ""
    failures = 0

    try:
      token = login(args.iam_url, args.email, args.password)
      print("OK   authenticated with IAM")

      status, created = request_json(args.base_url, "POST", "/api/workgraph/workflow-templates", {
          "name": name,
          "description": "Temporary lifecycle smoke workflow. Safe to archive/delete.",
          "profile": "main",
          "capabilityId": capability_id,
          "workflowTypeKey": "GENERAL",
          "defaultRoutingMode": "MANUAL",
          "metadata": {
              "workflowType": "BUSINESS",
              "domain": "Smoke",
              "criticality": "LOW",
              "visibility": "PRIVATE",
          },
      }, token=token)
      require(status == 201, f"create workflow failed: HTTP {status} {short_error(created)}")
      workflow_id = str(created.get("id") or "")
      require(bool(workflow_id), "create workflow response did not include id")
      require(created.get("designInstanceId") == workflow_id, "create workflow did not expose designInstanceId")
      print(f"OK   created workflow {workflow_id}")

      status, patched = request_json(args.base_url, "PATCH", f"/api/workgraph/workflow-templates/{workflow_id}", {
          "description": "Temporary lifecycle smoke workflow - patched.",
          "metadata": {
              "workflowType": "BUSINESS",
              "domain": "Smoke",
              "criticality": "LOW",
              "visibility": "PRIVATE",
              "tags": [{"key": "smoke", "value": "platform-web"}],
          },
      }, token=token)
      require(status == 200, f"patch workflow failed: HTTP {status} {short_error(patched)}")
      require(patched.get("description") == "Temporary lifecycle smoke workflow - patched.", "patch response did not reflect updated description")
      print("OK   patched workflow metadata")

      status, start_node = request_json(args.base_url, "POST", f"/api/workgraph/workflow-templates/{workflow_id}/design/nodes", {
          "nodeType": "START",
          "label": "Start",
          "config": {},
          "executionLocation": "SERVER",
          "positionX": 80,
          "positionY": 160,
      }, token=token)
      require(status == 201, f"create START node failed: HTTP {status} {short_error(start_node)}")
      start_id = str(start_node.get("id") or "")
      require(bool(start_id), "START node response did not include id")

      status, end_node = request_json(args.base_url, "POST", f"/api/workgraph/workflow-templates/{workflow_id}/design/nodes", {
          "nodeType": "END",
          "label": "Done",
          "config": {},
          "executionLocation": "SERVER",
          "positionX": 360,
          "positionY": 160,
      }, token=token)
      require(status == 201, f"create END node failed: HTTP {status} {short_error(end_node)}")
      end_id = str(end_node.get("id") or "")
      require(bool(end_id), "END node response did not include id")
      print("OK   created design nodes")

      status, edge = request_json(args.base_url, "POST", f"/api/workgraph/workflow-templates/{workflow_id}/design/edges", {
          "sourceNodeId": start_id,
          "targetNodeId": end_id,
          "edgeType": "SEQUENTIAL",
          "label": "finish",
      }, token=token)
      require(status == 201, f"create design edge failed: HTTP {status} {short_error(edge)}")
      require(edge.get("sourceNodeId") == start_id and edge.get("targetNodeId") == end_id, "edge response did not connect created nodes")
      print("OK   created design edge")

      status, graph = request_json(args.base_url, "GET", f"/api/workgraph/workflow-templates/{workflow_id}/design-graph", token=token)
      require(status == 200, f"read design graph failed: HTTP {status} {short_error(graph)}")
      nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
      edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
      require(any(node.get("id") == start_id for node in nodes), "design graph did not include START node")
      require(any(node.get("id") == end_id for node in nodes), "design graph did not include END node")
      require(any(item.get("sourceNodeId") == start_id and item.get("targetNodeId") == end_id for item in edges), "design graph did not include created edge")
      print("OK   verified design graph")

      status, work_item = request_json(args.base_url, "POST", "/api/workgraph/work-items", {
          "title": f"{name} WorkItem",
          "description": "Temporary WorkItem used by Platform Web lifecycle smoke.",
          "workItemTypeKey": "feature",
          "urgency": "NORMAL",
          "input": {"tenantId": "legacy-local"},
          "targets": [{"targetCapabilityId": capability_id}],
      }, token=token)
      require(status == 201, f"create WorkItem failed: HTTP {status} {short_error(work_item)}")
      work_item_id = str(work_item.get("id") or "")
      require(bool(work_item_id), "create WorkItem response did not include id")
      targets = work_item.get("targets") if isinstance(work_item.get("targets"), list) else []
      target = next((item for item in targets if item.get("targetCapabilityId") == capability_id), None)
      require(isinstance(target, dict), "create WorkItem response did not include target")
      target_id = str(target.get("id") or "")
      require(bool(target_id), "create WorkItem target response did not include id")
      print("OK   created WorkItem target")

      status, claimed = request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/targets/{target_id}/claim", {}, token=token)
      require(status == 200, f"claim WorkItem target failed: HTTP {status} {short_error(claimed)}")
      require(claimed.get("status") == "CLAIMED", "claim response did not mark target CLAIMED")
      print("OK   claimed WorkItem target")

      status, started = request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/targets/{target_id}/start", {
          "childWorkflowTemplateId": workflow_id,
      }, token=token)
      require(status == 200, f"start WorkItem target failed: HTTP {status} {short_error(started)}")
      run_id = str(started.get("childWorkflowInstanceId") or "")
      require(bool(run_id), "start WorkItem target response did not include childWorkflowInstanceId")
      started_target = started.get("target") if isinstance(started.get("target"), dict) else {}
      require(started_target.get("childWorkflowTemplateId") == workflow_id, "started target did not retain child workflow template id")
      require(started_target.get("childWorkflowInstanceId") == run_id, "started target did not retain child workflow run id")
      print(f"OK   started workflow run {run_id} from WorkItem")

      status, run = request_json(args.base_url, "GET", f"/api/workgraph/workflow-instances/{run_id}", token=token)
      require(status == 200, f"read workflow run failed: HTTP {status} {short_error(run)}")
      require(run.get("templateId") == workflow_id, "workflow run did not reference smoke template")
      require(run.get("status") == "COMPLETED", "workflow run did not complete")
      run_nodes = run.get("nodes") if isinstance(run.get("nodes"), list) else []
      require(any(node.get("nodeType") == "START" and node.get("status") == "COMPLETED" for node in run_nodes), "workflow run did not complete START node")
      require(any(node.get("nodeType") == "END" and node.get("status") == "COMPLETED" for node in run_nodes), "workflow run did not complete END node")
      print("OK   verified workflow run execution")

      status, linked_work_item = request_json(args.base_url, "GET", f"/api/workgraph/work-items/{work_item_id}", token=token)
      require(status == 200, f"read linked WorkItem failed: HTTP {status} {short_error(linked_work_item)}")
      linked_targets = linked_work_item.get("targets") if isinstance(linked_work_item.get("targets"), list) else []
      linked_target = next((item for item in linked_targets if item.get("id") == target_id), None)
      require(isinstance(linked_target, dict), "linked WorkItem did not include smoke target")
      require(linked_target.get("childWorkflowInstanceId") == run_id, "linked WorkItem target did not reference workflow run")
      require(linked_target.get("status") == "SUBMITTED", "linked WorkItem target was not submitted after child run completion")
      print("OK   verified WorkItem run link and submission")

      status, deleted_run = request_json(args.base_url, "DELETE", f"/api/workgraph/workflow-instances/{run_id}", token=token)
      require(status == 204, f"delete/archive workflow run failed: HTTP {status} {short_error(deleted_run)}")
      status, archived_run = request_json(args.base_url, "GET", f"/api/workgraph/workflow-instances/{run_id}", token=token)
      require(status == 200, f"read archived workflow run failed: HTTP {status} {short_error(archived_run)}")
      require(bool(archived_run.get("archivedAt")), "delete/archive workflow run did not set archivedAt")
      run_id = ""
      print("OK   delete/archive compatibility hid temporary workflow run")

      status, approved_work_item = request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/approve", {}, token=token)
      require(status == 200, f"approve WorkItem failed: HTTP {status} {short_error(approved_work_item)}")
      require(approved_work_item.get("status") == "COMPLETED", "approve WorkItem response did not mark status COMPLETED")
      print("OK   approved temporary WorkItem")

      status, archived_work_item = request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/archive", {}, token=token)
      require(status == 200, f"archive WorkItem failed: HTTP {status} {short_error(archived_work_item)}")
      require(archived_work_item.get("status") == "ARCHIVED", "archive WorkItem response did not mark status ARCHIVED")
      work_item_id = ""
      print("OK   archived temporary WorkItem")

      status, archived = request_json(args.base_url, "POST", f"/api/workgraph/workflow-templates/{workflow_id}/archive", {}, token=token)
      require(status == 200, f"archive workflow failed: HTTP {status} {short_error(archived)}")
      require(bool(archived.get("archivedAt")), "archive response did not include archivedAt")
      workflow_id = ""
      print("OK   archived temporary workflow")
    except Exception as exc:
      failures += 1
      print(f"FAIL {exc}", file=sys.stderr)
    finally:
      if run_id:
          token = locals().get("token")
          status, body = request_json(args.base_url, "DELETE", f"/api/workgraph/workflow-instances/{run_id}", token=token)
          if status == 204:
              print(f"OK   cleanup delete/archive workflow run {run_id}")
          else:
              print(f"WARN cleanup archive failed for workflow run {run_id}: HTTP {status} {short_error(body)}", file=sys.stderr)
      if work_item_id:
          token = locals().get("token")
          request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/approve", {}, token=token)
          status, archived = request_json(args.base_url, "POST", f"/api/workgraph/work-items/{work_item_id}/archive", {}, token=token)
          if status == 200 and archived.get("status") == "ARCHIVED":
              print(f"OK   cleanup archived WorkItem {work_item_id}")
          else:
              print(f"WARN cleanup archive failed for WorkItem {work_item_id}: HTTP {status} {short_error(archived)}", file=sys.stderr)
      if workflow_id:
          token = locals().get("token")
          status, archived = request_json(args.base_url, "POST", f"/api/workgraph/workflow-templates/{workflow_id}/archive", {}, token=token)
          if status == 200 and archived.get("archivedAt"):
              print(f"OK   cleanup archived workflow {workflow_id}")
          else:
              print(f"WARN cleanup archive failed for {workflow_id}: HTTP {status} {short_error(archived)}", file=sys.stderr)

    if failures:
        print(f"\n{failures} workflow lifecycle smoke check(s) failed.", file=sys.stderr)
        return 1

    print("\nWorkflow lifecycle smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
