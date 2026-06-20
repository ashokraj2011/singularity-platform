#!/usr/bin/env python3
"""Create, resolve, and archive a source-backed agent profile through Platform Web."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def request_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None, token: str | None = None, timeout: float = 10) -> tuple[int, dict[str, Any]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", "user-agent": "singularity-agent-profile-smoke"}
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


def main() -> int:
    default_email, default_password = bootstrap_credentials()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:5180")
    parser.add_argument("--iam-url", default="http://localhost:8100")
    parser.add_argument("--email", default=default_email)
    parser.add_argument("--password", default=default_password)
    args = parser.parse_args()

    profile_id = ""
    failures = 0
    try:
        token = login(args.iam_url, args.email, args.password)
        print("OK   authenticated with IAM")

        capability_id = first_active_capability(args.base_url, token)
        print(f"OK   selected capability {capability_id}")

        timestamp = int(time.time())
        url_ref = f"https://example.com/singularity-agent-source-{timestamp}.md"
        provider_ref = f"https://provider.invalid/singularity-smoke-manifest-{timestamp}.json"

        status, preview = request_json(args.base_url, "POST", "/api/runtime/agents/skill-sources/preview", {
            "sourceType": "url_document",
            "url": url_ref,
            "name": "Smoke URL document",
        }, token=token)
        require(status == 200, f"preview URL document failed: HTTP {status} {short_error(preview)}")
        preview_data = unwrap(preview)
        require(preview_data.get("readOnly") is True, "URL preview was not read-only")
        require(preview_data.get("providerLocked") is True, "URL preview was not provider-locked")
        require(preview_data.get("defaultPermissions") == ["read"], "URL preview default permissions were not read-only")
        print("OK   previewed read-only URL skill source")

        status, created_body = request_json(args.base_url, "POST", "/api/runtime/agents/profiles", {
            "capabilityId": capability_id,
            "name": f"__singularity_agent_profile_smoke_{timestamp}__",
            "roleType": "BUSINESS_ANALYST",
            "description": "Temporary source-backed agent profile smoke. Safe to archive.",
            "instructions": "Use external documents as read-only context and invoke only explicitly invokable local skills.",
            "skillBindings": [
                {
                    "sourceType": "local",
                    "name": "Smoke local invoker",
                    "description": "Local smoke skill with invoke permission.",
                    "skillType": "SMOKE_LOCAL",
                    "permissions": ["read", "invoke"],
                    "metadata": {"capabilityId": "smoke.local.invoke", "capabilityName": "Smoke local invoke"},
                },
                {
                    "sourceType": "url_document",
                    "name": "Smoke URL document",
                    "description": "Read-only URL document smoke source.",
                    "skillType": "DOCUMENT_SOURCE",
                    "url": url_ref,
                    "permissions": ["read", "invoke", "edit"],
                    "metadata": {"capabilityName": "Smoke URL document"},
                },
                {
                    "sourceType": "provider_manifest",
                    "name": "Smoke provider manifest",
                    "description": "Provider-locked manifest smoke source.",
                    "skillType": "PROVIDER_MANIFEST",
                    "providerManifestUrl": provider_ref,
                    "permissions": ["read", "invoke", "edit"],
                    "readOnly": False,
                    "providerLocked": True,
                    "metadata": {"provider": "smoke-provider"},
                },
            ],
        }, token=token)
        require(status == 201, f"create agent profile failed: HTTP {status} {short_error(created_body)}")
        created = unwrap(created_body)
        profile = created.get("profile") if isinstance(created.get("profile"), dict) else created.get("template")
        require(isinstance(profile, dict), "create response did not include profile/template")
        profile_id = str(profile.get("id") or "")
        require(profile_id, "created profile did not include id")
        require(profile.get("status") == "DRAFT", "created profile was not DRAFT")
        summary = created.get("effectivePermissions")
        require(isinstance(summary, list) and len(summary) == 3, "permission summary did not include three bindings")
        by_source = {item.get("sourceType"): item for item in summary if isinstance(item, dict)}
        require(by_source.get("local", {}).get("permissions") == ["read", "invoke"], "local skill did not retain invoke permission")
        require(by_source.get("url_document", {}).get("permissions") == ["read"], "URL document was not clamped to read-only")
        require(by_source.get("provider_manifest", {}).get("permissions") == ["read"], "provider-locked manifest was not clamped to read-only")
        require(by_source.get("provider_manifest", {}).get("providerLocked") is True, "provider manifest binding was not provider-locked")
        print(f"OK   created source-backed DRAFT agent profile {profile_id}")

        status, sources_body = request_json(args.base_url, "GET", f"/api/runtime/agents/profiles/{profile_id}/sources", token=token)
        require(status == 200, f"read agent profile source governance failed: HTTP {status} {short_error(sources_body)}")
        sources_data = unwrap(sources_body)
        source_summary = sources_data.get("summary") if isinstance(sources_data.get("summary"), dict) else {}
        sources = sources_data.get("sources") if isinstance(sources_data.get("sources"), list) else []
        require(source_summary.get("totalBindings") == 3, "source governance summary did not include three bindings")
        require(source_summary.get("externalBindings") == 2, "source governance summary did not count external bindings")
        require(source_summary.get("documentBindings") == 1, "source governance summary did not count document binding")
        require(source_summary.get("providerManifestBindings") == 1, "source governance summary did not count provider manifest binding")
        require(source_summary.get("readOnlyBindings") == 2, "source governance summary did not count read-only bindings")
        require(source_summary.get("providerLockedBindings") == 2, "source governance summary did not count provider-locked bindings")
        require(source_summary.get("liveResolutionRequired") == 1, "source governance summary did not count live provider resolution")
        require(any(isinstance(item, dict) and item.get("sourceType") == "url_document" and item.get("sourceArtifact", {}).get("kind") == "knowledge_source" for item in sources), "URL document source did not expose linked knowledge source")
        print("OK   inspected stored source governance summary")

        status, resolved_body = request_json(args.base_url, "POST", f"/api/runtime/agents/profiles/{profile_id}/resolve", {}, token=token)
        require(status == 200, f"resolve agent profile failed: HTTP {status} {short_error(resolved_body)}")
        resolved = unwrap(resolved_body)
        caps = resolved.get("effectiveCapabilities")
        require(isinstance(caps, list), "resolve response did not include effectiveCapabilities")
        require(any(isinstance(cap, dict) and cap.get("id") == "smoke.local.invoke" and "invoke" in cap.get("permissions", []) for cap in caps), "resolved local invokable capability missing")
        require(any(isinstance(cap, dict) and cap.get("sourceType") == "url_document" and cap.get("readOnly") is True and cap.get("permissions") == ["read"] for cap in caps), "resolved URL document was not read-only")
        providers = resolved.get("providerResolutions")
        require(isinstance(providers, list), "resolve response did not include providerResolutions")
        require(any(isinstance(provider, dict) and provider.get("sourceRef") == provider_ref and provider.get("status") == "failed_closed" for provider in providers), "invalid provider manifest did not fail closed")
        summary_data = resolved.get("summary") if isinstance(resolved.get("summary"), dict) else {}
        require(summary_data.get("failedProviders") == 1, "resolve summary did not count the failed provider")
        print("OK   resolved profile with read-only docs and failed-closed provider")

        status, archived_body = request_json(args.base_url, "PATCH", f"/api/runtime/agents/templates/{profile_id}", {
            "status": "ARCHIVED",
            "changeSummary": "Archived temporary agent profile smoke.",
        }, token=token)
        require(status == 200, f"archive agent profile failed: HTTP {status} {short_error(archived_body)}")
        archived = unwrap(archived_body)
        require(archived.get("status") == "ARCHIVED", "archive response did not mark profile ARCHIVED")
        profile_id = ""
        print("OK   archived temporary agent profile")
    except Exception as exc:
        failures += 1
        print(f"FAIL {exc}", file=sys.stderr)
    finally:
        if profile_id:
            try:
                token = locals().get("token")
                status, body = request_json(args.base_url, "PATCH", f"/api/runtime/agents/templates/{profile_id}", {
                    "status": "ARCHIVED",
                    "changeSummary": "Cleanup after failed agent profile smoke.",
                }, token=token)
                if status == 200 and unwrap(body).get("status") == "ARCHIVED":
                    print(f"OK   cleanup archived agent profile {profile_id}")
                else:
                    print(f"WARN cleanup archive failed for agent profile {profile_id}: HTTP {status} {short_error(body)}", file=sys.stderr)
            except Exception as cleanup_exc:
                print(f"WARN cleanup archive failed for agent profile {profile_id}: {cleanup_exc}", file=sys.stderr)

    if failures:
        print(f"\n{failures} agent profile lifecycle smoke check(s) failed.", file=sys.stderr)
        return 1
    print("\nAgent profile lifecycle smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
