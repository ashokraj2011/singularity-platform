#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: bin/check-deploy-env.sh [--config-only] [--allow-dev] [--env-file PATH ...]

Checks the deploy boundary before a remote/staging/production Docker host is
updated. By default it verifies both:

  1. GitHub Actions deploy transport variables: DEPLOY_HOST, DEPLOY_USER,
     DEPLOY_PATH, and DEPLOY_SSH_KEY or DEPLOY_SSH_KEY_FILE.
  2. Production-class platform guardrails loaded from process env,
     local env files, and .singularity/config.local.json.

Options:
  --config-only   skip DEPLOY_* and Docker CLI checks; useful in CI/unit smoke
                  runs that only validate the platform config contract.
  --allow-dev     allow development/local APP_ENV values. Intended only for
                  throwaway remote Docker hosts, never shared environments.
  --env-file PATH include an additional env file. Later files override earlier
                  files, but exported shell env overrides every file.
  -h, --help      show this help.
EOF
}

config_only=0
allow_dev="${ALLOW_DEV_DEPLOY:-0}"
env_files=(
  ".env"
  ".env.local"
  ".env.deploy"
  ".env.production"
  "agent-and-tools/.env"
  "agent-and-tools/web/.env.local"
  "workgraph-studio/apps/api/.env"
  "context-fabric/.env"
  "mcp-server/.env"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-only)
      config_only=1
      shift
      ;;
    --allow-dev)
      allow_dev=1
      shift
      ;;
    --env-file)
      if [[ -z "${2:-}" ]]; then
        echo "missing value for --env-file" >&2
        exit 2
      fi
      env_files+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

missing=0

ok() {
  echo "ok $*"
}

fail_check() {
  echo "missing $*" >&2
  missing=1
}

if [[ "$config_only" -ne 1 ]]; then
  for name in DEPLOY_HOST DEPLOY_USER DEPLOY_PATH; do
    if [[ -z "${!name:-}" ]]; then
      fail_check "$name"
    else
      ok "$name"
    fi
  done

  if [[ -z "${DEPLOY_SSH_KEY:-}" && -z "${DEPLOY_SSH_KEY_FILE:-}" ]]; then
    fail_check "DEPLOY_SSH_KEY or DEPLOY_SSH_KEY_FILE"
  else
    ok "deploy ssh key"
  fi

  if command -v docker >/dev/null; then
    ok "docker CLI"
  else
    fail_check "docker CLI"
  fi

  if docker compose version >/dev/null 2>&1; then
    ok "docker compose plugin"
  else
    fail_check "docker compose plugin"
  fi
fi

python3 - "$allow_dev" "${env_files[@]}" <<'PY'
from __future__ import annotations

import json
import base64
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


allow_dev = sys.argv[1].strip().lower() in {"1", "true", "yes", "on"}
env_files = [Path(p) for p in sys.argv[2:]]
root = Path.cwd()
missing = 0

CONFIG_KEY_MAP = {
    "platform.appEnv": "APP_ENV",
    "platform.environment": "ENVIRONMENT",
    "platform.singularityEnv": "SINGULARITY_ENV",
    "platform.authOptional": "AUTH_OPTIONAL",
    "platform.requireTenantId": "REQUIRE_TENANT_ID",
    "platform.tenantIsolationMode": "TENANT_ISOLATION_MODE",
    "platform.workgraphProxyServiceToken": "WORKGRAPH_PROXY_SERVICE_TOKEN",
    "identity.jwtSecret": "JWT_SECRET",
    "identity.bootstrapPassword": "LOCAL_SUPER_ADMIN_PASSWORD",
    "tokens.iamServiceTokenTenantIds": "IAM_SERVICE_TOKEN_TENANT_IDS",
    "tokens.workgraphInternalTokenTenantIds": "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS",
    "tokens.contextFabricServiceToken": "CONTEXT_FABRIC_SERVICE_TOKEN",
    "tokens.auditGovServiceToken": "AUDIT_GOV_SERVICE_TOKEN",
    "tokens.learningServiceToken": "LEARNING_SERVICE_TOKEN",
    "tokens.workgraphInternalToken": "WORKGRAPH_INTERNAL_TOKEN",
    "tokens.workgraphEventSecretKey": "WORKGRAPH_EVENT_SECRET_KEY",
    "tokens.workgraphIncomingEventSecrets": "WORKGRAPH_INCOMING_EVENT_SECRETS",
    "services.auditGovUrl": "AUDIT_GOV_URL",
    "services.workgraphDatabaseUrl": "WORKGRAPH_DATABASE_URL",
    "services.workgraphRuntimeDatabaseUrl": "WORKGRAPH_RUNTIME_DATABASE_URL",
    "services.workgraphAdminDatabaseUrl": "WORKGRAPH_DATABASE_URL_ADMIN",
    "mcpRuntime.bearerToken": "MCP_BEARER_TOKEN",
    "mcpRuntime.defaultGovernanceMode": "MCP_DEFAULT_GOVERNANCE_MODE",
    "mcpRuntime.toolGrantMode": "MCP_TOOL_GRANT_MODE",
    "mcpRuntime.requireEffectiveCapabilities": "MCP_REQUIRE_EFFECTIVE_CAPABILITIES",
    "mcpRuntime.toolGrantSigningSecret": "TOOL_GRANT_SIGNING_SECRET",
    "mcpRuntime.runnerToken": "MCP_RUNNER_TOKEN",
    "agentRuntime.providerManifestSignatureMode": "PROVIDER_MANIFEST_SIGNATURE_MODE",
    "agentRuntime.providerManifestTrustedKeys": "PROVIDER_MANIFEST_TRUSTED_KEYS",
    "agentRuntime.providerManifestMaxTtlSeconds": "PROVIDER_MANIFEST_MAX_TTL_SECONDS",
    "agentRuntime.allowPrivateSourceUrls": "AGENT_SOURCE_ALLOW_PRIVATE_URLS",
    "contextFabric.defaultGovernanceMode": "DEFAULT_GOVERNANCE_MODE",
    "contextFabric.toolGrantEnabled": "CF_TOOL_GRANT_ENABLED",
    "toolService.serverEndpointAllowlist": "TOOL_SERVER_ENDPOINT_ALLOWLIST",
    "git.push.enabled": "MCP_GIT_PUSH_ENABLED",
    "git.auth.mode": "MCP_GIT_AUTH_MODE",
}

WEAK_EXACT = {
    "",
    "Admin1234!",
    "change-me-in-production",
    "change-me-now",
    "changeme_dev_only_min_32_chars_long!!",
    "dev-secret-change-in-prod-min-32-chars!!",
    "demo-bearer-token-must-be-min-16-chars",
    "dev-context-fabric-service-token",
    "dev-audit-gov-service-token",
    "dev-workgraph-internal-token",
    "dev-codegen-service-token",
    "dev-mcp-runner-token-min-16-chars",
    "dev-tool-grant-signing-secret-min-32-chars!!",
}


def emit(status: str, message: str) -> None:
    global missing
    print(f"{status} {message}", file=sys.stderr if status == "FAIL" else sys.stdout)
    if status == "FAIL":
        missing = 1


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        value = value.strip()
        try:
            parts = shlex.split(value, comments=True, posix=True)
            value = parts[0] if parts else ""
        except ValueError:
            value = value.strip("\"'")
        out[key] = value
    return out


def get_path(data: dict, dotted: str) -> object | None:
    cur: object = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def load_config_env() -> dict[str, str]:
    path = root / ".singularity/config.local.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        emit("FAIL", f"canonical config is not readable JSON: {path}: {exc}")
        return {}
    out: dict[str, str] = {}
    for dotted, key in CONFIG_KEY_MAP.items():
        value = get_path(data, dotted)
        if value is None:
            continue
        if isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = str(value)
    return out


merged: dict[str, str] = {}
merged.update(load_config_env())
for env_file in env_files:
    merged.update(parse_env_file(env_file))
for key, value in os.environ.items():
    if value:
        merged[key] = value


def value(key: str, default: str = "") -> str:
    return (merged.get(key) or default).strip()


def is_true(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def weak_secret(raw: str) -> bool:
    val = raw.strip()
    low = val.lower()
    if val in WEAK_EXACT:
        return True
    if low.startswith(("dev-", "test-", "change-me", "changeme", "placeholder", "example")):
        return True
    if re.search(r"<[^>]+>|\.\.\.|replace_me", low):
        return True
    return False


def weak_incoming_event_secrets(raw: str) -> list[str]:
    value = raw.strip()
    if not value:
        return ["<empty>"]
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return ["<invalid-json>"]
    if not isinstance(parsed, dict) or not parsed:
        return ["<invalid-json>"]
    weak: list[str] = []
    for source, secret in parsed.items():
        source_name = str(source).strip() or "<empty-source>"
        if not isinstance(secret, str) or len(secret.strip()) < 32 or weak_secret(secret):
            weak.append(source_name)
    return weak


def jwt_like(raw: str) -> bool:
    parts = raw.strip().split(".")
    if len(parts) != 3:
        return False
    return all(re.fullmatch(r"[A-Za-z0-9_-]+", part or "") for part in parts)


def jwt_payload(raw: str) -> dict:
    if not jwt_like(raw):
        return {}
    try:
        payload = raw.strip().split(".")[1]
        payload += "=" * ((4 - len(payload) % 4) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
        return decoded if isinstance(decoded, dict) else {}
    except Exception:
        return {}


def acceptable_evidence(raw: str) -> bool:
    evidence = raw.strip()
    if len(evidence) >= 12:
        return True
    return bool(re.fullmatch(r"[A-Z][A-Z0-9]+-\d{1,8}", evidence))


def audit_health_candidates(raw_url: str) -> list[str]:
    raw_url = (raw_url or "").strip().rstrip("/")
    if not raw_url:
        return []
    parsed = urllib.parse.urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return [raw_url]
    health_path = "/health" if not parsed.path or parsed.path == "/" else parsed.path
    base = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, health_path, "", "", ""))
    candidates = [base]
    if parsed.hostname in {"host.docker.internal", "audit-governance", "audit-governance-service"}:
        localhost_netloc = f"localhost:{parsed.port or 8500}"
        candidates.insert(0, urllib.parse.urlunparse((parsed.scheme, localhost_netloc, health_path, "", "", "")))
    return list(dict.fromkeys(candidates))


def audit_gov_reachable(raw_url: str, token: str) -> tuple[bool, str]:
    headers = {"user-agent": "singularity-deploy-preflight"}
    if token.strip():
        headers["authorization"] = f"Bearer {token.strip()}"
    errors: list[str] = []
    for candidate in audit_health_candidates(raw_url):
        try:
            req = urllib.request.Request(candidate, headers=headers)
            with urllib.request.urlopen(req, timeout=4) as res:
                if 200 <= res.status < 300:
                    return True, candidate
                errors.append(f"{candidate} returned HTTP {res.status}")
        except urllib.error.HTTPError as exc:
            if 200 <= exc.code < 300:
                return True, candidate
            errors.append(f"{candidate} returned HTTP {exc.code}")
        except Exception as exc:
            errors.append(f"{candidate}: {exc}")
    return False, "; ".join(errors) or "no AUDIT_GOV_URL configured"


env_signal = ",".join(
    filter(
        None,
        [
            value("APP_ENV"),
            value("ENVIRONMENT"),
            value("SINGULARITY_ENV"),
            value("NODE_ENV"),
        ],
    )
).lower()
prod_like = any(part in {"production", "prod", "staging", "perf"} for part in re.split(r"[, ]+", env_signal) if part)
if prod_like:
    emit("OK", f"production-class environment selected ({env_signal})")
elif allow_dev:
    emit("WARN", "development environment allowed by --allow-dev / ALLOW_DEV_DEPLOY=1")
else:
    emit("FAIL", "set APP_ENV or SINGULARITY_ENV to production, staging, or perf before deploy")

required_exact = {
    "AUTH_OPTIONAL": "false",
    "AUTH_PROVIDER": "iam",
    "TENANT_ISOLATION_MODE": "strict",
    "REQUIRE_TENANT_ID": "true",
    "DEFAULT_GOVERNANCE_MODE": "fail_closed",
    "CF_TOOL_GRANT_ENABLED": "true",
    "MCP_DEFAULT_GOVERNANCE_MODE": "fail_closed",
    "MCP_TOOL_GRANT_MODE": "enforce",
    "MCP_REQUIRE_EFFECTIVE_CAPABILITIES": "true",
}
for key, expected in required_exact.items():
    got = value(key, "true" if key == "AUTH_OPTIONAL" else "")
    if got.lower() == expected:
        emit("OK", f"{key}={expected}")
    else:
        emit("FAIL", f"{key} must be {expected} for production-class deploys")

audit_gov_url = value("AUDIT_GOV_URL")
if not audit_gov_url:
    emit("FAIL", "AUDIT_GOV_URL is required when DEFAULT_GOVERNANCE_MODE=fail_closed")
else:
    emit("OK", f"AUDIT_GOV_URL configured ({audit_gov_url})")
    audit_reachable, audit_detail = audit_gov_reachable(audit_gov_url, value("AUDIT_GOV_SERVICE_TOKEN"))
    if audit_reachable:
        emit("OK", f"audit-governance reachable for fail-closed preflight ({audit_detail})")
    else:
        emit(
            "FAIL",
            "audit-governance must be reachable before fail-closed production deploys: "
            + audit_detail,
        )

tenant_token_ids = [item.strip() for item in value("IAM_SERVICE_TOKEN_TENANT_IDS").split(",") if item.strip()]
if tenant_token_ids:
    emit("OK", f"IAM_SERVICE_TOKEN_TENANT_IDS configured ({len(set(tenant_token_ids))} tenant scope(s))")
else:
    emit("FAIL", "IAM_SERVICE_TOKEN_TENANT_IDS must be configured so service tokens are tenant-scoped")

internal_token_ids = [item.strip() for item in value("WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS").split(",") if item.strip()]
if internal_token_ids:
    emit("OK", f"WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS configured ({len(set(internal_token_ids))} tenant scope(s))")
else:
    emit("FAIL", "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS must be configured so Workgraph internal tokens are tenant-scoped")

signature_mode = value("PROVIDER_MANIFEST_SIGNATURE_MODE", "auto").lower()
if signature_mode == "required":
    emit("OK", "PROVIDER_MANIFEST_SIGNATURE_MODE=required")
else:
    emit("FAIL", "PROVIDER_MANIFEST_SIGNATURE_MODE must be required for production-class deploys")

trusted_keys = value("PROVIDER_MANIFEST_TRUSTED_KEYS")
if trusted_keys:
    emit("OK", "PROVIDER_MANIFEST_TRUSTED_KEYS configured")
else:
    emit("FAIL", "PROVIDER_MANIFEST_TRUSTED_KEYS must be configured so external skill manifests are signed")

def parse_manifest_keys(raw):
    raw = (raw or "").strip()
    if not raw:
        return {}
    if raw.startswith("{"):
        try:
            parsed = json.loads(raw)
        except Exception:
            return {"<invalid-json>": ""}
        if not isinstance(parsed, dict):
            return {"<invalid-json>": ""}
        return {str(key): secret for key, secret in parsed.items()}
    out = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" not in item:
            out[item] = ""
            continue
        key, secret = item.split(":", 1)
        out[key.strip()] = secret
    return out

weak_manifest_keys = [
    key or "<empty-key>"
    for key, secret in parse_manifest_keys(trusted_keys).items()
    if not isinstance(secret, str) or len(secret.strip()) < 32
]
if weak_manifest_keys:
    emit("FAIL", "PROVIDER_MANIFEST_TRUSTED_KEYS contains weak key secret(s): " + ", ".join(weak_manifest_keys))
elif trusted_keys:
    emit("OK", "PROVIDER_MANIFEST_TRUSTED_KEYS secrets are strong")

ttl_raw = value("PROVIDER_MANIFEST_MAX_TTL_SECONDS", "2592000")
try:
    ttl_seconds = int(ttl_raw)
except ValueError:
    ttl_seconds = 0
if ttl_seconds < 300:
    emit("FAIL", "PROVIDER_MANIFEST_MAX_TTL_SECONDS must be at least 300")
elif ttl_seconds > 90 * 24 * 60 * 60:
    emit("FAIL", "PROVIDER_MANIFEST_MAX_TTL_SECONDS must be 90 days or less")
else:
    emit("OK", f"PROVIDER_MANIFEST_MAX_TTL_SECONDS={ttl_seconds}")

agent_source_allow_private_urls = value("AGENT_SOURCE_ALLOW_PRIVATE_URLS", "false").lower()
if agent_source_allow_private_urls in {"1", "true", "yes", "on"}:
    emit("FAIL", "AGENT_SOURCE_ALLOW_PRIVATE_URLS must be false for production-class deploys")
else:
    emit("OK", "AGENT_SOURCE_ALLOW_PRIVATE_URLS=false")

weak_incoming_sources = weak_incoming_event_secrets(value("WORKGRAPH_INCOMING_EVENT_SECRETS"))
if weak_incoming_sources:
    emit("FAIL", "WORKGRAPH_INCOMING_EVENT_SECRETS has missing or weak source secret(s): " + ", ".join(weak_incoming_sources))
else:
    emit("OK", "WORKGRAPH_INCOMING_EVENT_SECRETS configured")

secret_keys = [
    "JWT_SECRET",
    "LOCAL_SUPER_ADMIN_PASSWORD",
    "CONTEXT_FABRIC_SERVICE_TOKEN",
    "AUDIT_GOV_SERVICE_TOKEN",
    "LEARNING_SERVICE_TOKEN",
    "WORKGRAPH_INTERNAL_TOKEN",
    "WORKGRAPH_EVENT_SECRET_KEY",
    "MCP_BEARER_TOKEN",
    "MCP_RUNNER_TOKEN",
    "TOOL_GRANT_SIGNING_SECRET",
]
for key in secret_keys:
    got = value(key)
    if len(got) < 32 or weak_secret(got):
        emit("FAIL", f"{key} must be a rotated 32+ character non-default secret")
    else:
        emit("OK", f"{key} is rotated")

workgraph_proxy_token = value("WORKGRAPH_PROXY_SERVICE_TOKEN")
workgraph_proxy_payload = jwt_payload(workgraph_proxy_token)
if not workgraph_proxy_payload:
    emit("FAIL", "WORKGRAPH_PROXY_SERVICE_TOKEN must be a pre-minted IAM service JWT for platform-web -> Workgraph proxy auth")
elif (
    workgraph_proxy_payload.get("kind") != "service"
    or workgraph_proxy_payload.get("service_name") != "platform-web"
    or workgraph_proxy_payload.get("sub") != "service:platform-web"
):
    emit("FAIL", "WORKGRAPH_PROXY_SERVICE_TOKEN must be minted by IAM for service_name=platform-web")
else:
    scopes = {scope for scope in workgraph_proxy_payload.get("scopes", []) if isinstance(scope, str)}
    required_scopes = {"read:reference-data", "read:mcp-servers", "publish:events"}
    missing_scopes = sorted(required_scopes - scopes)
    token_tenant_ids = sorted({tenant_id.strip() for tenant_id in workgraph_proxy_payload.get("tenant_ids", []) if isinstance(tenant_id, str) and tenant_id.strip()})
    required_tenant_ids = sorted(set(tenant_token_ids))
    if missing_scopes:
        emit("FAIL", "WORKGRAPH_PROXY_SERVICE_TOKEN is missing required scope(s): " + ", ".join(missing_scopes))
    elif required_tenant_ids and token_tenant_ids != required_tenant_ids:
        emit("FAIL", "WORKGRAPH_PROXY_SERVICE_TOKEN tenant_ids must exactly match IAM_SERVICE_TOKEN_TENANT_IDS")
    elif prod_like and not token_tenant_ids:
        emit("FAIL", "WORKGRAPH_PROXY_SERVICE_TOKEN must carry tenant_ids for production-class deploys")
    else:
        suffix = f" ({len(token_tenant_ids)} tenant scope(s))" if token_tenant_ids else ""
        emit("OK", f"WORKGRAPH_PROXY_SERVICE_TOKEN is a platform-web IAM service JWT{suffix}")

if is_true(value("MCP_GIT_PUSH_ENABLED", "false")):
    if value("MCP_TOOL_GRANT_MODE", "").lower() == "enforce":
        emit(
            "OK",
            "MCP_GIT_PUSH_ENABLED=true will use Workgraph -> Context Fabric operational grants before MCP finish-branch",
        )
    mode = value("MCP_GIT_AUTH_MODE", "disabled").lower()
    if mode not in {"ssh", "token"}:
        emit("FAIL", "MCP_GIT_AUTH_MODE must be ssh or token when MCP_GIT_PUSH_ENABLED=true")
    elif mode == "ssh" and not value("MCP_GIT_SSH_KEY_HOST_PATH"):
        emit("FAIL", "MCP_GIT_SSH_KEY_HOST_PATH is required for Git push ssh mode")
    elif mode == "token":
        token_env = value("MCP_GIT_TOKEN_ENV", "GITHUB_TOKEN")
        if not value(token_env):
            emit("FAIL", f"{token_env} must be present in the deploy runner env for Git push token mode")
        else:
            emit("OK", f"Git push token env configured ({token_env})")
    else:
        emit("OK", "Git push ssh mode configured")
else:
    emit("OK", "Git push disabled at deploy boundary")

iam_auth_mode = value("IAM_AUTH_MODE", "local").lower()
if iam_auth_mode not in {"local", "oidc"}:
    emit("FAIL", "IAM_AUTH_MODE must be local or oidc")
elif iam_auth_mode == "oidc":
    emit("OK", "IAM_AUTH_MODE=oidc")
    for key in ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI"]:
        if not value(key):
            emit("FAIL", f"{key} is required when IAM_AUTH_MODE=oidc")
    for key in ["OIDC_ISSUER_URL", "OIDC_REDIRECT_URI"]:
        if value(key) and not value(key).lower().startswith("https://"):
            emit("FAIL", f"{key} must be https:// for production SSO")
    oidc_secret = value("OIDC_CLIENT_SECRET")
    if len(oidc_secret) < 32 or weak_secret(oidc_secret):
        emit("FAIL", "OIDC_CLIENT_SECRET must be a rotated 32+ character non-default secret")
else:
    emit("OK", "IAM_AUTH_MODE=local")

tenant_db_checker = root / "bin/check-workgraph-db-tenant-isolation.py"
database_url_fallback = value("DATABASE_URL")
if database_url_fallback and not re.search(r"/workgraph(?:[?]|$)", database_url_fallback):
    database_url_fallback = ""
workgraph_database_url = value("WORKGRAPH_RUNTIME_DATABASE_URL") or value("WORKGRAPH_DATABASE_URL") or value("DATABASE_URL_WORKGRAPH") or database_url_fallback
if prod_like and not workgraph_database_url:
    emit("FAIL", "WORKGRAPH_DATABASE_URL is required so deploy preflight can verify Workgraph tenant DB posture")
elif workgraph_database_url and tenant_db_checker.exists():
    cmd = [
        sys.executable,
        str(tenant_db_checker),
        "--database-url",
        workgraph_database_url,
    ]
    if prod_like:
        cmd.extend(["--require-db", "--strict-data"])
    rls_required = value("WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED", "true" if prod_like else "false").lower()
    if rls_required in {"0", "false", "no", "off"} and prod_like:
        alternate_model = value("WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL").lower()
        evidence = value("WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE")
        allowed_models = {"schema-per-tenant", "database-per-tenant", "cluster-per-tenant"}
        if alternate_model not in allowed_models:
            emit(
                "FAIL",
                "WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED=false requires WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL=schema-per-tenant|database-per-tenant|cluster-per-tenant",
            )
        elif not acceptable_evidence(evidence):
            emit(
                "FAIL",
                "WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED=false requires WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE with a ticket, runbook, or architecture reference",
            )
        else:
            emit("WARN", f"forced-RLS production check disabled; alternate Workgraph DB isolation model documented as {alternate_model} ({evidence})")
    elif is_true(rls_required):
        cmd.append("--require-rls")
    result = subprocess.run(cmd, cwd=root, text=True, capture_output=True, check=False)
    if result.returncode == 0:
        emit("OK", "Workgraph tenant DB posture verified")
    else:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        first_line = detail[0] if detail else "unknown failure"
        emit("FAIL", f"Workgraph tenant DB posture failed: {first_line}")
elif not tenant_db_checker.exists():
    emit("FAIL", "missing bin/check-workgraph-db-tenant-isolation.py")
else:
    emit("WARN", "Workgraph tenant DB posture skipped for development deploy without WORKGRAPH_DATABASE_URL")

if missing:
    print("Deploy environment is incomplete.", file=sys.stderr)
    sys.exit(1)

print("Deploy environment is ready.")
PY
py_status=$?
if [[ "$py_status" -ne 0 ]]; then
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  echo "Deploy environment is incomplete." >&2
  exit 1
fi
