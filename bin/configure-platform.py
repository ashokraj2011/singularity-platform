#!/usr/bin/env python3
"""Singularity platform configuration utility.

Centralizes the knobs that are otherwise scattered across docker compose
interpolation, Context Fabric, Workgraph, Agent-and-Tools, and the local MCP
server. The utility never deletes unknown env keys; it only updates the keys it
owns and appends missing keys with a marker block.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
OWNED_MARKER = "# --- Singularity config utility managed values ---"
CONFIG_DIR = ROOT / ".singularity"
CONFIG_PATH = CONFIG_DIR / "config.local.json"
DOCTOR_PATH = CONFIG_DIR / "ops-doctor.json"
PLATFORM_DOCTOR_PATH = ROOT / "agent-and-tools/web/public/ops-doctor.json"
PORTAL_DOCTOR_PATH = ROOT / "singularity-portal/public/ops-doctor.json"

LOCAL_OVERRIDE_DRIFT_KEYS = {
    "MCP_GIT_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "COPILOT_TOKEN",
    "COPILOT_PROVIDER_API_KEY",
}


SECRET_HINTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASS", "DATABASE")
DEFAULT_MCP_RUNNER_IMAGE_MAP = {
    "python": "python:3.12-slim",
    "python3": "python:3.12-slim",
    "pytest": "python:3.12-slim",
    "go": "golang:1.23-alpine",
    "cargo": "rust:1.83-alpine",
    "mvn": "maven:3.9-eclipse-temurin-21",
    "gradle": "gradle:8-jdk21",
    "gradlew": "gradle:8-jdk21",
    "dotnet": "mcr.microsoft.com/dotnet/sdk:8.0",
}

COPILOT_ONLY_PROFILES = {"office-copilot-only"}

PROFILE_IAM_MODES = {
    "local-docker": "real-iam-dev",
    "office-laptop": "real-iam-dev",
    "office-copilot-only": "real-iam-dev",
    "pseudo-iam-dev": "pseudo-iam-dev",
    "real-iam-dev": "real-iam-dev",
}

PROFILE_CHOICES = list(PROFILE_IAM_MODES)
TRUE_ENV_VALUES = {"1", "true", "yes", "on"}


CONFIG_KEY_MAP = {
    "platform.appEnv": "APP_ENV",
    "platform.environment": "ENVIRONMENT",
    "platform.singularityEnv": "SINGULARITY_ENV",
    "platform.authOptional": "AUTH_OPTIONAL",
    "platform.requireTenantId": "REQUIRE_TENANT_ID",
    "platform.tenantIsolationMode": "TENANT_ISOLATION_MODE",
    "platform.workgraphProxyServiceToken": "WORKGRAPH_PROXY_SERVICE_TOKEN",
    "identity.jwtSecret": "JWT_SECRET",
    "identity.iamBaseUrl": "IAM_BASE_URL",
    "identity.iamServiceUrl": "IAM_SERVICE_URL",
    "identity.iamDatabaseUrl": "IAM_DATABASE_URL",
    "identity.bootstrapEmail": "LOCAL_SUPER_ADMIN_EMAIL",
    "identity.bootstrapPassword": "LOCAL_SUPER_ADMIN_PASSWORD",
    "services.agentToolsDatabaseUrl": "AGENT_TOOLS_DATABASE_URL",
    "services.workgraphDatabaseUrl": "WORKGRAPH_DATABASE_URL",
    "services.workgraphRuntimeDatabaseUrl": "WORKGRAPH_RUNTIME_DATABASE_URL",
    "services.workgraphAdminDatabaseUrl": "WORKGRAPH_DATABASE_URL_ADMIN",
    "services.promptComposerUrl": "PROMPT_COMPOSER_URL",
    "services.agentRuntimeUrl": "AGENT_RUNTIME_URL",
    "services.toolServiceUrl": "TOOL_SERVICE_URL",
    "services.agentServiceUrl": "AGENT_SERVICE_URL",
    "services.contextFabricUrl": "CONTEXT_FABRIC_URL",
    "services.auditGovUrl": "AUDIT_GOV_URL",
    "services.blueprintWorkbenchUrl": "BLUEPRINT_WORKBENCH_URL",
    "services.workgraphArtifactFetchUrl": "WORKGRAPH_ARTIFACT_FETCH_URL",
    "services.formalVerifierUrl": "FORMAL_VERIFIER_URL",
    "agentRuntime.providerManifestSignatureMode": "PROVIDER_MANIFEST_SIGNATURE_MODE",
    "agentRuntime.providerManifestTrustedKeys": "PROVIDER_MANIFEST_TRUSTED_KEYS",
    "agentRuntime.providerManifestMaxTtlSeconds": "PROVIDER_MANIFEST_MAX_TTL_SECONDS",
    "agentRuntime.allowPrivateSourceUrls": "AGENT_SOURCE_ALLOW_PRIVATE_URLS",
    "contextFabric.defaultGovernanceMode": "DEFAULT_GOVERNANCE_MODE",
    "contextFabric.toolGrantEnabled": "CF_TOOL_GRANT_ENABLED",
    "workgraph.forceGovernedCoding": "WORKGRAPH_FORCE_GOVERNED_CODING",
    "workgraph.governSideCallers": "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS",
    "toolService.serverEndpointAllowlist": "TOOL_SERVER_ENDPOINT_ALLOWLIST",
    "tokens.contextFabricServiceToken": "CONTEXT_FABRIC_SERVICE_TOKEN",
    "tokens.auditGovServiceToken": "AUDIT_GOV_SERVICE_TOKEN",
    "tokens.learningServiceToken": "LEARNING_SERVICE_TOKEN",
    "tokens.workgraphInternalToken": "WORKGRAPH_INTERNAL_TOKEN",
    "tokens.workgraphEventSecretKey": "WORKGRAPH_EVENT_SECRET_KEY",
    "tokens.workgraphIncomingEventSecrets": "WORKGRAPH_INCOMING_EVENT_SECRETS",
    "tokens.iamServiceTokenTenantIds": "IAM_SERVICE_TOKEN_TENANT_IDS",
    "tokens.workgraphInternalTokenTenantIds": "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS",
    "mcpRuntime.serverUrl": "MCP_SERVER_URL",
    "mcpRuntime.publicBaseUrl": "MCP_PUBLIC_BASE_URL",
    "mcpRuntime.bearerToken": "MCP_BEARER_TOKEN",
    "mcpRuntime.defaultGovernanceMode": "MCP_DEFAULT_GOVERNANCE_MODE",
    "mcpRuntime.toolGrantMode": "MCP_TOOL_GRANT_MODE",
    "mcpRuntime.requireEffectiveCapabilities": "MCP_REQUIRE_EFFECTIVE_CAPABILITIES",
    "mcpRuntime.toolGrantSigningSecret": "TOOL_GRANT_SIGNING_SECRET",
    "mcpRuntime.sandboxRoot": "MCP_SANDBOX_ROOT",
    "mcpRuntime.commandExecutionMode": "MCP_COMMAND_EXECUTION_MODE",
    "mcpRuntime.runnerUrl": "MCP_RUNNER_URL",
    "mcpRuntime.runnerToken": "MCP_RUNNER_TOKEN",
    "mcpRuntime.runnerHostWorkspacePath": "MCP_RUNNER_HOST_WORKSPACE_PATH",
    "mcpRuntime.runnerDefaultImage": "MCP_RUNNER_DEFAULT_IMAGE",
    "mcpRuntime.runnerImageMapJson": "MCP_RUNNER_IMAGE_MAP_JSON",
    "mcpRuntime.runnerNetworkMode": "MCP_RUNNER_NETWORK_MODE",
    "mcpRuntime.astDbPath": "MCP_AST_DB_PATH",
    "mcpRuntime.astMaxFileBytes": "MCP_AST_MAX_FILE_BYTES",
    "mcpRuntime.astMaxWorkspaceBytes": "MCP_AST_MAX_WORKSPACE_BYTES",
    "mcpRuntime.astMaxSymbols": "MCP_AST_MAX_SYMBOLS",
    "mcpRuntime.workBranchPrefix": "MCP_WORK_BRANCH_PREFIX",
    "git.push.enabled": "MCP_GIT_PUSH_ENABLED",
    "git.auth.mode": "MCP_GIT_AUTH_MODE",
    "git.remoteName": "MCP_GIT_PUSH_REMOTE",
    "git.sshKeyPath": "MCP_GIT_SSH_KEY_HOST_PATH",
    "git.tokenEnv": "MCP_GIT_TOKEN_ENV",
    "git.defaultBranchPrefix": "MCP_WORK_BRANCH_PREFIX",
    "llm.provider": "LLM_PROVIDER",
    "llm.model": "LLM_MODEL",
    "llm.allowedProviders": "MCP_ALLOWED_LLM_PROVIDERS",
    "llm.providerConfigPath": "MCP_LLM_PROVIDER_CONFIG_PATH",
    "llm.providerConfigJson": "MCP_LLM_PROVIDER_CONFIG_JSON",
    "llm.modelCatalogPath": "MCP_LLM_MODEL_CATALOG_PATH",
    "llm.modelCatalogJson": "MCP_LLM_MODEL_CATALOG_JSON",
    "llm.openai.apiKey": "OPENAI_API_KEY",
    "llm.openai.baseUrl": "OPENAI_BASE_URL",
    "llm.openrouter.apiKey": "OPENROUTER_API_KEY",
    "llm.openrouter.baseUrl": "OPENROUTER_BASE_URL",
    "llm.ollama.baseUrl": "OLLAMA_BASE_URL",
    "llm.anthropic.apiKey": "ANTHROPIC_API_KEY",
    "llm.copilot.token": "COPILOT_TOKEN",
    "llm.copilot.baseUrl": "COPILOT_BASE_URL",
    "llm.copilot.defaultModel": "COPILOT_DEFAULT_MODEL",
    "formalVerification.enabled": "FORMAL_VERIFICATION_ENABLED",
    "formalVerification.defaultTimeoutMs": "FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS",
    "formalVerification.maxTimeoutMs": "FORMAL_VERIFICATION_MAX_TIMEOUT_MS",
}


def mask(key: str, value: str | None) -> str:
    if value is None:
        return ""
    if key.upper().endswith("_TENANT_IDS"):
        return value
    if any(h in key.upper() for h in SECRET_HINTS):
        if not value:
            return "(empty)"
        if len(value) <= 8:
            return "****"
        return f"{value[:4]}...{value[-4:]}"
    return value


def get_path(data: dict, dotted: str) -> object | None:
    cur: object = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def set_path(data: dict, dotted: str, value: object) -> None:
    cur = data
    parts = dotted.split(".")
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def strong_secret(prefix: str, *, bytes_len: int = 32) -> str:
    return f"{prefix}_{secrets.token_urlsafe(bytes_len)}"


def weak_secret_value(raw: str) -> bool:
    val = (raw or "").strip()
    low = val.lower()
    if not val:
        return True
    if val in {
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
    }:
        return True
    if low.startswith(("dev-", "test-", "change-me", "changeme", "placeholder", "example")):
        return True
    return bool(re.search(r"<[^>]+>|\.\.\.|replace_me", low))


def env_truthy(raw: str | None) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


TENANT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def normalize_tenant_ids(raw_values: Iterable[str]) -> list[str]:
    tenant_ids: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        for item in str(raw).split(","):
            tenant_id = item.strip()
            if not tenant_id:
                continue
            if not TENANT_ID_PATTERN.match(tenant_id):
                raise SystemExit(
                    f"Invalid tenant id {tenant_id!r}. Use 1-128 characters: letters, numbers, dot, underscore, colon, or dash."
                )
            if tenant_id not in seen:
                seen.add(tenant_id)
                tenant_ids.append(tenant_id)
    if not tenant_ids:
        raise SystemExit("At least one --tenant-id is required for production guardrails.")
    return tenant_ids


def looks_like_jwt(value: str) -> bool:
    parts = value.strip().split(".")
    if len(parts) != 3:
        return False
    return all(bool(re.fullmatch(r"[A-Za-z0-9_-]+", part)) for part in parts)


def local_config_prod_like(data: dict) -> bool:
    signals = [
        str(get_path(data, "platform.appEnv") or ""),
        str(get_path(data, "platform.environment") or ""),
        str(get_path(data, "platform.singularityEnv") or ""),
    ]
    return any(signal.strip().lower() in {"prod", "production", "staging", "perf"} for signal in signals)


def absolute_local_path(value: str) -> str:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    return str(path.resolve(strict=False))


def load_local_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception as exc:
        print(f"WARN could not read {CONFIG_PATH.relative_to(ROOT)}: {exc}", file=sys.stderr)
        return {}


def flatten_local_config(data: dict | None = None) -> dict[str, str]:
    data = data if data is not None else load_local_config()
    out: dict[str, str] = {}
    for dotted, env_key in CONFIG_KEY_MAP.items():
        value = get_path(data, dotted)
        if value is None:
            continue
        out[env_key] = "true" if value is True else "false" if value is False else str(value)
    if get_path(data, "identity.mode") == "pseudo-iam-dev":
        out.setdefault("IAM_BASE_URL", "http://localhost:8101/api/v1")
        out.setdefault("IAM_SERVICE_URL", "http://localhost:8101")
    return out


def config_template(profile: str, args: argparse.Namespace | None = None) -> dict:
    mode = PROFILE_IAM_MODES.get(profile, "real-iam-dev")
    use_pseudo = mode == "pseudo-iam-dev"
    copilot_only = (
        profile in COPILOT_ONLY_PROFILES
        or bool(getattr(args, "office_copilot_only", False))
        if args
        else profile in COPILOT_ONLY_PROFILES
    )
    sandbox_root = getattr(args, "mcp_sandbox_root", None) if args else None
    sandbox_root = sandbox_root or str(ROOT)
    provider = getattr(args, "llm_provider", None) if args else None
    provider = provider or ("copilot" if copilot_only else "mock")
    model = getattr(args, "llm_model", None) if args else None
    model = model or ("gpt-4o" if provider == "copilot" else "mock-fast")
    openai_key = getattr(args, "openai_api_key", None) if args else None
    openrouter_key = getattr(args, "openrouter_api_key", None) if args else None
    anthropic_key = getattr(args, "anthropic_api_key", None) if args else None
    copilot_token = getattr(args, "copilot_token", None) if args else None
    openai_base_url = getattr(args, "openai_base_url", None) if args else None
    openrouter_base_url = getattr(args, "openrouter_base_url", None) if args else None
    copilot_base_url = getattr(args, "copilot_base_url", None) if args else None
    mcp_token = getattr(args, "mcp_bearer_token", None) if args else None
    runner_host_workspace = absolute_local_path(os.getenv("MCP_SANDBOX_HOST_PATH", sandbox_root))
    return {
        "profile": profile,
        "identity": {
            "mode": mode,
            "iamBaseUrl": "http://localhost:8101/api/v1" if use_pseudo else "http://localhost:8100/api/v1",
            "iamServiceUrl": "http://localhost:8101" if use_pseudo else "http://localhost:8100",
            "iamDatabaseUrl": "postgresql+asyncpg://singularity:singularity@localhost:5432/singularity_iam",
            "jwtSecret": os.getenv("JWT_SECRET", "changeme_dev_only_min_32_chars_long!!"),
            "bootstrapEmail": "admin@singularity.local",
            "bootstrapPassword": "Admin1234!",
        },
        "services": {
            "agentToolsDatabaseUrl": "postgresql://postgres:singularity@localhost:5432/singularity",
            "workgraphDatabaseUrl": "postgresql://workgraph_app:workgraph_app_secret@localhost:5434/workgraph",
            "workgraphAdminDatabaseUrl": "postgresql://workgraph:workgraph_secret@localhost:5434/workgraph",
            "promptComposerUrl": "http://localhost:3004",
            "agentRuntimeUrl": "http://localhost:3003",
            "toolServiceUrl": "http://localhost:3001",
            "agentServiceUrl": "http://localhost:3001",
            "contextFabricUrl": "http://localhost:8000",
            "auditGovUrl": "http://localhost:8500",
            "blueprintWorkbenchUrl": "http://localhost:5180/workbench",
            "workgraphArtifactFetchUrl": "http://localhost:8080/api/internal/artifacts/fetch",
            "formalVerifierUrl": "http://localhost:8010",
        },
        "agentRuntime": {
            "providerManifestSignatureMode": os.getenv("PROVIDER_MANIFEST_SIGNATURE_MODE", "auto"),
            "providerManifestTrustedKeys": os.getenv("PROVIDER_MANIFEST_TRUSTED_KEYS", ""),
            "providerManifestMaxTtlSeconds": int(os.getenv("PROVIDER_MANIFEST_MAX_TTL_SECONDS", "2592000")),
            "allowPrivateSourceUrls": os.getenv("AGENT_SOURCE_ALLOW_PRIVATE_URLS", "false").lower() == "true",
        },
        "contextFabric": {
            "defaultGovernanceMode": os.getenv("DEFAULT_GOVERNANCE_MODE", "fail_open"),
            "toolGrantEnabled": env_truthy(os.getenv("CF_TOOL_GRANT_ENABLED", "false")),
        },
        "workgraph": {
            "forceGovernedCoding": os.getenv("WORKGRAPH_FORCE_GOVERNED_CODING", "true").lower() != "false",
            "governSideCallers": os.getenv("CONTEXT_FABRIC_GOVERN_SIDE_CALLERS", "true").lower() != "false",
        },
        "toolService": {
            "serverEndpointAllowlist": os.getenv("TOOL_SERVER_ENDPOINT_ALLOWLIST", ""),
        },
        "tokens": {
            "contextFabricServiceToken": os.getenv("CONTEXT_FABRIC_SERVICE_TOKEN", "dev-context-fabric-service-token"),
            "auditGovServiceToken": os.getenv("AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token"),
            "learningServiceToken": os.getenv(
                "LEARNING_SERVICE_TOKEN",
                os.getenv("AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token"),
            ),
            "workgraphInternalToken": os.getenv("WORKGRAPH_INTERNAL_TOKEN", "dev-workgraph-internal-token"),
            "workgraphEventSecretKey": os.getenv("WORKGRAPH_EVENT_SECRET_KEY", "dev-workgraph-event-secret-min-32-chars"),
            "workgraphIncomingEventSecrets": os.getenv(
                "WORKGRAPH_INCOMING_EVENT_SECRETS",
                json.dumps({
                    "agent-runtime": "dev-workgraph-incoming-event-secret-min-32-chars",
                    "agent-service": "dev-workgraph-incoming-event-secret-min-32-chars",
                    "tool-service": "dev-workgraph-incoming-event-secret-min-32-chars",
                    "iam": "dev-workgraph-incoming-event-secret-min-32-chars",
                }, separators=(",", ":")),
            ),
            "iamServiceTokenTenantIds": os.getenv("IAM_SERVICE_TOKEN_TENANT_IDS", ""),
            "workgraphInternalTokenTenantIds": os.getenv("WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS", ""),
        },
        "mcpRuntime": {
            "serverUrl": "http://localhost:7100",
            "publicBaseUrl": "http://host.docker.internal:7100",
            "bearerToken": mcp_token or os.getenv("MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars"),
            "defaultGovernanceMode": os.getenv("MCP_DEFAULT_GOVERNANCE_MODE", "fail_open"),
            "toolGrantMode": os.getenv("MCP_TOOL_GRANT_MODE", "off"),
            "requireEffectiveCapabilities": env_truthy(os.getenv("MCP_REQUIRE_EFFECTIVE_CAPABILITIES", "false")),
            "toolGrantSigningSecret": os.getenv("TOOL_GRANT_SIGNING_SECRET", "dev-tool-grant-signing-secret-min-32-chars!!"),
            "sandboxRoot": sandbox_root,
            "commandExecutionMode": os.getenv("MCP_COMMAND_EXECUTION_MODE", "container"),
            "runnerUrl": os.getenv("MCP_RUNNER_URL", "http://mcp-sandbox-runner:7110"),
            "runnerToken": os.getenv("MCP_RUNNER_TOKEN", "dev-mcp-runner-token-min-16-chars"),
            "runnerHostWorkspacePath": os.getenv("MCP_RUNNER_HOST_WORKSPACE_PATH", runner_host_workspace),
            "runnerDefaultImage": os.getenv("MCP_RUNNER_DEFAULT_IMAGE", "node:20-alpine"),
            "runnerImageMapJson": os.getenv("MCP_RUNNER_IMAGE_MAP_JSON", json.dumps(DEFAULT_MCP_RUNNER_IMAGE_MAP, separators=(",", ":"))),
            "runnerNetworkMode": os.getenv("MCP_RUNNER_NETWORK_MODE", "none"),
            "astDbPath": f"{sandbox_root.rstrip('/')}/.singularity/mcp-ast.sqlite",
            "astMaxFileBytes": 200000,
            "astMaxWorkspaceBytes": 24000000,
            "astMaxSymbols": 250000,
            "workBranchPrefix": "sg",
        },
        "git": {
            "push": {"enabled": False},
            "auth": {"mode": "disabled"},
            "remoteName": "origin",
            "sshKeyPath": "",
            "tokenEnv": "GITHUB_TOKEN",
            "defaultBranchPrefix": "sg",
        },
        "llm": {
            "provider": provider,
            "model": model,
            "allowedProviders": "copilot" if copilot_only else provider,
            "providerConfigPath": ".singularity/llm-providers.json",
            "providerConfigJson": "",
            "modelCatalogPath": ".singularity/llm-models.json",
            "modelCatalogJson": "",
            "openai": {
                "apiKey": openai_key if provider == "openai" and not copilot_only else "",
                "baseUrl": openai_base_url if provider == "openai" and not copilot_only else "",
            },
            "openrouter": {
                "apiKey": openrouter_key if provider == "openrouter" and not copilot_only else "",
                "baseUrl": openrouter_base_url if provider == "openrouter" and not copilot_only else "",
            },
            "anthropic": {
                "apiKey": anthropic_key if provider == "anthropic" and not copilot_only else "",
            },
            "copilot": {
                "token": copilot_token if provider == "copilot" or copilot_only else "",
                "baseUrl": copilot_base_url or ("https://api.githubcopilot.com" if provider == "copilot" or copilot_only else ""),
                "defaultModel": model if provider == "copilot" else "gpt-4o",
            },
            "ollama": {
                "baseUrl": "" if copilot_only else "",
            },
        },
        "budgets": {
            "mode": "balanced",
            "workflowDefault": {
                "maxInputTokens": 32000,
                "maxOutputTokens": 8000,
                "maxTotalTokens": 40000,
                "warnAtPercent": 80,
                "enforcementMode": "PAUSE_FOR_APPROVAL",
            },
        },
        "formalVerification": {
            "enabled": False,
            "defaultTimeoutMs": 3000,
            "maxTimeoutMs": 10000,
        },
    }


def write_local_config(data: dict, *, force: bool = False) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if CONFIG_PATH.exists() and not force:
        raise SystemExit(f"{CONFIG_PATH.relative_to(ROOT)} already exists. Use --force to overwrite.")
    CONFIG_PATH.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {CONFIG_PATH.relative_to(ROOT)}")


def parse_env(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = value[1:-1]
        out[key] = value
    return out


def quote_env(value: str) -> str:
    if value == "":
        return ""
    if re.search(r"\s|#|'|\"", value):
        return json.dumps(value)
    return value


def write_env(path: Path, updates: dict[str, str], *, dry_run: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_lines = path.read_text().splitlines() if path.exists() else []
    seen: set[str] = set()
    changed = False
    new_lines: list[str] = []

    for raw in existing_lines:
        stripped = raw.strip()
        match = re.match(r"^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", stripped)
        if not match:
            new_lines.append(raw)
            continue
        key = match.group(2)
        if key not in updates:
            new_lines.append(raw)
            continue
        prefix = "export " if stripped.startswith("export ") else ""
        next_line = f"{prefix}{key}={quote_env(updates[key])}"
        new_lines.append(next_line)
        seen.add(key)
        changed = changed or next_line != raw

    missing = [key for key in updates if key not in seen]
    if missing:
        if new_lines and new_lines[-1].strip():
            new_lines.append("")
        new_lines.append(OWNED_MARKER)
        for key in missing:
            new_lines.append(f"{key}={quote_env(updates[key])}")
        changed = True

    if dry_run:
        print(f"\n# {path.relative_to(ROOT)}")
        for key in updates:
            print(f"{key}={mask(key, updates[key])}")
        return

    if changed or not path.exists():
        path.write_text("\n".join(new_lines).rstrip() + "\n")
    print(f"wrote {path.relative_to(ROOT)}")


def default_values(args: argparse.Namespace) -> dict[str, str]:
    local = flatten_local_config()

    def pick(key: str, arg_name: str | None, env_name: str | None, default: str) -> str:
        if arg_name:
            arg_value = getattr(args, arg_name, None)
            if arg_value is not None:
                return str(arg_value)
        if key in local:
            return local[key]
        if env_name:
            return os.getenv(env_name, default)
        return default

    use_pseudo = bool(getattr(args, "pseudo_iam", False))
    if not use_pseudo and local.get("IAM_BASE_URL", "").startswith("http://localhost:8101"):
        use_pseudo = True
    allowed_providers = pick("MCP_ALLOWED_LLM_PROVIDERS", "allowed_llm_providers", "MCP_ALLOWED_LLM_PROVIDERS", "")
    copilot_only = allowed_providers.strip().lower() == "copilot"
    llm_provider = pick("LLM_PROVIDER", "llm_provider", "LLM_PROVIDER", "copilot" if copilot_only else "mock")
    if not allowed_providers.strip():
        allowed_providers = llm_provider or "mock"
    llm_model = pick("LLM_MODEL", "llm_model", "LLM_MODEL", (
        "mock-fast" if llm_provider == "mock"
        else "gpt-4o" if llm_provider == "copilot"
        else "openai/gpt-4o-mini" if llm_provider == "openrouter"
        else "mock-fast"
    ))
    openai_key = pick("OPENAI_API_KEY", "openai_api_key", None, "")
    openai_base_url = pick("OPENAI_BASE_URL", "openai_base_url", None, "")
    openrouter_key = pick("OPENROUTER_API_KEY", "openrouter_api_key", None, "")
    openrouter_base_url = pick("OPENROUTER_BASE_URL", "openrouter_base_url", None, "")
    anthropic_key = pick("ANTHROPIC_API_KEY", "anthropic_api_key", None, "")
    copilot_token = pick("COPILOT_TOKEN", "copilot_token", None, "")
    copilot_base_url = pick("COPILOT_BASE_URL", "copilot_base_url", None, "https://api.githubcopilot.com" if llm_provider == "copilot" else "")
    mcp_token = pick("MCP_BEARER_TOKEN", "mcp_bearer_token", "MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars")
    jwt_secret = pick("JWT_SECRET", "jwt_secret", "JWT_SECRET", "changeme_dev_only_min_32_chars_long!!")
    service_token = pick("CONTEXT_FABRIC_SERVICE_TOKEN", "service_token", "CONTEXT_FABRIC_SERVICE_TOKEN", "dev-context-fabric-service-token")
    audit_token = pick("AUDIT_GOV_SERVICE_TOKEN", "audit_token", "AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token")
    learning_token = pick("LEARNING_SERVICE_TOKEN", "learning_token", "LEARNING_SERVICE_TOKEN", audit_token)
    workgraph_internal_token = pick("WORKGRAPH_INTERNAL_TOKEN", None, "WORKGRAPH_INTERNAL_TOKEN", "dev-workgraph-internal-token")
    workgraph_event_secret_key = pick("WORKGRAPH_EVENT_SECRET_KEY", None, "WORKGRAPH_EVENT_SECRET_KEY", "dev-workgraph-event-secret-min-32-chars")
    workgraph_incoming_event_secrets = pick(
        "WORKGRAPH_INCOMING_EVENT_SECRETS",
        None,
        "WORKGRAPH_INCOMING_EVENT_SECRETS",
        json.dumps({
            "agent-runtime": "dev-workgraph-incoming-event-secret-min-32-chars",
            "agent-service": "dev-workgraph-incoming-event-secret-min-32-chars",
            "tool-service": "dev-workgraph-incoming-event-secret-min-32-chars",
            "iam": "dev-workgraph-incoming-event-secret-min-32-chars",
        }, separators=(",", ":")),
    )
    sandbox_root = pick("MCP_SANDBOX_ROOT", "mcp_sandbox_root", "MCP_SANDBOX_ROOT", str(ROOT))
    runner_host_workspace_default = absolute_local_path(os.getenv("MCP_SANDBOX_HOST_PATH", sandbox_root))
    runner_host_workspace = pick(
        "MCP_RUNNER_HOST_WORKSPACE_PATH",
        "mcp_runner_host_workspace_path",
        "MCP_RUNNER_HOST_WORKSPACE_PATH",
        runner_host_workspace_default,
    )
    runner_image_map_json = pick(
        "MCP_RUNNER_IMAGE_MAP_JSON",
        "mcp_runner_image_map_json",
        "MCP_RUNNER_IMAGE_MAP_JSON",
        json.dumps(DEFAULT_MCP_RUNNER_IMAGE_MAP, separators=(",", ":")),
    )
    formal_verification_enabled = pick("FORMAL_VERIFICATION_ENABLED", None, "FORMAL_VERIFICATION_ENABLED", "false")
    formal_verifier_url = pick("FORMAL_VERIFIER_URL", None, "FORMAL_VERIFIER_URL", "http://localhost:8010")
    formal_default_timeout_ms = pick("FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS", None, "FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS", "3000")
    formal_max_timeout_ms = pick("FORMAL_VERIFICATION_MAX_TIMEOUT_MS", None, "FORMAL_VERIFICATION_MAX_TIMEOUT_MS", "10000")
    git_push_enabled = pick("MCP_GIT_PUSH_ENABLED", None, "MCP_GIT_PUSH_ENABLED", "false")
    git_auth_mode = pick("MCP_GIT_AUTH_MODE", None, "MCP_GIT_AUTH_MODE", "disabled")
    git_remote = pick("MCP_GIT_PUSH_REMOTE", None, "MCP_GIT_PUSH_REMOTE", "origin")
    git_token_env = pick("MCP_GIT_TOKEN_ENV", None, "MCP_GIT_TOKEN_ENV", "GITHUB_TOKEN")
    git_token = os.getenv(git_token_env, os.getenv("MCP_GIT_TOKEN", ""))
    git_ssh_key_host_path = pick("MCP_GIT_SSH_KEY_HOST_PATH", None, "MCP_GIT_SSH_KEY_HOST_PATH", "")
    git_ssh_key_container_path = "/run/secrets/singularity_git_ssh_key" if git_ssh_key_host_path else ""

    iam_base_default = "http://localhost:8101/api/v1" if use_pseudo else "http://localhost:8100/api/v1"
    iam_service_default = "http://localhost:8101" if use_pseudo else "http://localhost:8100"
    iam_base = pick("IAM_BASE_URL", "iam_base_url", "IAM_BASE_URL", iam_base_default)
    iam_service = pick("IAM_SERVICE_URL", "iam_service_url", "IAM_SERVICE_URL", iam_service_default)
    app_env = pick("APP_ENV", "app_env", "APP_ENV", os.getenv("SINGULARITY_ENV", "development"))
    environment = pick("ENVIRONMENT", "environment", "ENVIRONMENT", os.getenv("SINGULARITY_ENV", app_env))
    singularity_env = pick("SINGULARITY_ENV", "singularity_env", "SINGULARITY_ENV", app_env)
    bootstrap_email = pick("LOCAL_SUPER_ADMIN_EMAIL", None, "LOCAL_SUPER_ADMIN_EMAIL", "admin@singularity.local")
    bootstrap_password = pick("LOCAL_SUPER_ADMIN_PASSWORD", None, "LOCAL_SUPER_ADMIN_PASSWORD", "Admin1234!")

    return {
        "APP_ENV": app_env,
        "ENVIRONMENT": environment,
        "SINGULARITY_ENV": singularity_env,
        "AUTH_OPTIONAL": pick("AUTH_OPTIONAL", "auth_optional", "AUTH_OPTIONAL", "true"),
        "REQUIRE_TENANT_ID": pick("REQUIRE_TENANT_ID", "require_tenant_id", "REQUIRE_TENANT_ID", "false"),
        "TENANT_ISOLATION_MODE": pick("TENANT_ISOLATION_MODE", "tenant_isolation_mode", "TENANT_ISOLATION_MODE", "off"),
        "JWT_SECRET": jwt_secret,
        "LOCAL_SUPER_ADMIN_EMAIL": bootstrap_email,
        "LOCAL_SUPER_ADMIN_PASSWORD": bootstrap_password,
        "IAM_BOOTSTRAP_USERNAME": pick("IAM_BOOTSTRAP_USERNAME", None, "IAM_BOOTSTRAP_USERNAME", bootstrap_email),
        "IAM_BOOTSTRAP_PASSWORD": pick("IAM_BOOTSTRAP_PASSWORD", None, "IAM_BOOTSTRAP_PASSWORD", bootstrap_password),
        "AUTH_PROVIDER": "iam",
        "IAM_BASE_URL": iam_base,
        "IAM_SERVICE_URL": iam_service,
        "IAM_DATABASE_URL": pick("IAM_DATABASE_URL", "iam_database_url", "IAM_DATABASE_URL", "postgresql+asyncpg://singularity:singularity@localhost:5432/singularity_iam"),
        "AGENT_TOOLS_DATABASE_URL": pick("AGENT_TOOLS_DATABASE_URL", "agent_tools_database_url", "AGENT_TOOLS_DATABASE_URL", "postgresql://postgres:singularity@localhost:5432/singularity"),
        "WORKGRAPH_DATABASE_URL": pick("WORKGRAPH_DATABASE_URL", "workgraph_database_url", "WORKGRAPH_DATABASE_URL", "postgresql://workgraph_app:workgraph_app_secret@localhost:5434/workgraph"),
        "WORKGRAPH_RUNTIME_DATABASE_URL": pick("WORKGRAPH_RUNTIME_DATABASE_URL", "workgraph_database_url", "WORKGRAPH_RUNTIME_DATABASE_URL", "postgresql://workgraph_app:workgraph_app_secret@localhost:5434/workgraph"),
        "WORKGRAPH_DATABASE_URL_ADMIN": pick("WORKGRAPH_DATABASE_URL_ADMIN", "workgraph_admin_database_url", "WORKGRAPH_DATABASE_URL_ADMIN", "postgresql://workgraph:workgraph_secret@localhost:5434/workgraph"),
        "CONTEXT_FABRIC_SERVICE_TOKEN": service_token,
        "AUDIT_GOV_SERVICE_TOKEN": audit_token,
        "LEARNING_SERVICE_TOKEN": learning_token,
        "WORKGRAPH_INTERNAL_TOKEN": workgraph_internal_token,
        "WORKGRAPH_EVENT_SECRET_KEY": workgraph_event_secret_key,
        "WORKGRAPH_INCOMING_EVENT_SECRETS": workgraph_incoming_event_secrets,
        "IAM_SERVICE_TOKEN_TENANT_IDS": pick("IAM_SERVICE_TOKEN_TENANT_IDS", None, "IAM_SERVICE_TOKEN_TENANT_IDS", ""),
        "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS": pick("WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS", None, "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS", ""),
        "WORKGRAPH_PROXY_SERVICE_TOKEN": pick("WORKGRAPH_PROXY_SERVICE_TOKEN", "workgraph_proxy_service_token", "WORKGRAPH_PROXY_SERVICE_TOKEN", ""),
        "WORKGRAPH_ARTIFACT_FETCH_URL": pick("WORKGRAPH_ARTIFACT_FETCH_URL", None, "WORKGRAPH_ARTIFACT_FETCH_URL", "http://localhost:8080/api/internal/artifacts/fetch"),
        "WORKGRAPH_ARTIFACT_FETCH_TOKEN": workgraph_internal_token,
        "PROMPT_COMPOSER_URL": pick("PROMPT_COMPOSER_URL", "prompt_composer_url", "PROMPT_COMPOSER_URL", "http://localhost:3004"),
        "AGENT_RUNTIME_URL": pick("AGENT_RUNTIME_URL", "agent_runtime_url", "AGENT_RUNTIME_URL", "http://localhost:3003"),
        "TOOL_SERVICE_URL": pick("TOOL_SERVICE_URL", "tool_service_url", "TOOL_SERVICE_URL", "http://localhost:3001"),
        "AGENT_SERVICE_URL": pick("AGENT_SERVICE_URL", "agent_service_url", "AGENT_SERVICE_URL", "http://localhost:3001"),
        "CONTEXT_FABRIC_URL": pick("CONTEXT_FABRIC_URL", "context_fabric_url", "CONTEXT_FABRIC_URL", "http://localhost:8000"),
        "BLUEPRINT_WORKBENCH_URL": pick("BLUEPRINT_WORKBENCH_URL", "blueprint_workbench_url", "BLUEPRINT_WORKBENCH_URL", "http://localhost:5180/workbench"),
        "FORMAL_VERIFIER_URL": formal_verifier_url,
        "FORMAL_VERIFICATION_ENABLED": formal_verification_enabled,
        "FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS": formal_default_timeout_ms,
        "FORMAL_VERIFICATION_MAX_TIMEOUT_MS": formal_max_timeout_ms,
        "PROVIDER_MANIFEST_SIGNATURE_MODE": pick("PROVIDER_MANIFEST_SIGNATURE_MODE", "provider_manifest_signature_mode", "PROVIDER_MANIFEST_SIGNATURE_MODE", "auto"),
        "PROVIDER_MANIFEST_TRUSTED_KEYS": pick("PROVIDER_MANIFEST_TRUSTED_KEYS", "provider_manifest_trusted_keys", "PROVIDER_MANIFEST_TRUSTED_KEYS", ""),
        "PROVIDER_MANIFEST_MAX_TTL_SECONDS": pick("PROVIDER_MANIFEST_MAX_TTL_SECONDS", "provider_manifest_max_ttl_seconds", "PROVIDER_MANIFEST_MAX_TTL_SECONDS", "2592000"),
        "AGENT_SOURCE_ALLOW_PRIVATE_URLS": pick("AGENT_SOURCE_ALLOW_PRIVATE_URLS", "agent_source_allow_private_urls", "AGENT_SOURCE_ALLOW_PRIVATE_URLS", "false"),
        "DEFAULT_GOVERNANCE_MODE": pick("DEFAULT_GOVERNANCE_MODE", "default_governance_mode", "DEFAULT_GOVERNANCE_MODE", "fail_open"),
        "WORKGRAPH_FORCE_GOVERNED_CODING": pick("WORKGRAPH_FORCE_GOVERNED_CODING", "workgraph_force_governed_coding", "WORKGRAPH_FORCE_GOVERNED_CODING", "true"),
        "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS": pick("CONTEXT_FABRIC_GOVERN_SIDE_CALLERS", "context_fabric_govern_side_callers", "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS", "true"),
        "CF_TOOL_GRANT_ENABLED": pick("CF_TOOL_GRANT_ENABLED", "cf_tool_grant_enabled", "CF_TOOL_GRANT_ENABLED", "false"),
        "TOOL_SERVER_ENDPOINT_ALLOWLIST": pick("TOOL_SERVER_ENDPOINT_ALLOWLIST", "tool_server_endpoint_allowlist", "TOOL_SERVER_ENDPOINT_ALLOWLIST", ""),
        "MCP_SERVER_URL": pick("MCP_SERVER_URL", "mcp_server_url", "MCP_SERVER_URL", "http://localhost:7100"),
        "MCP_PUBLIC_BASE_URL": pick("MCP_PUBLIC_BASE_URL", "mcp_public_base_url", "MCP_PUBLIC_BASE_URL", "http://host.docker.internal:7100"),
        "MCP_DEFAULT_BASE_URL": pick("MCP_SERVER_URL", "mcp_server_url", "MCP_DEFAULT_BASE_URL", "http://localhost:7100"),
        "MCP_DEFAULT_BEARER_TOKEN": mcp_token,
        "MCP_DEFAULT_SERVER_ID": "local-default-mcp",
        "MCP_BEARER_TOKEN": mcp_token,
        "MCP_DEMO_BEARER_TOKEN": mcp_token,
        "MCP_DEFAULT_GOVERNANCE_MODE": pick("MCP_DEFAULT_GOVERNANCE_MODE", "mcp_default_governance_mode", "MCP_DEFAULT_GOVERNANCE_MODE", "fail_open"),
        "MCP_TOOL_GRANT_MODE": pick("MCP_TOOL_GRANT_MODE", "mcp_tool_grant_mode", "MCP_TOOL_GRANT_MODE", "off"),
        "MCP_REQUIRE_EFFECTIVE_CAPABILITIES": pick("MCP_REQUIRE_EFFECTIVE_CAPABILITIES", "mcp_require_effective_capabilities", "MCP_REQUIRE_EFFECTIVE_CAPABILITIES", "false"),
        "TOOL_GRANT_SIGNING_SECRET": pick("TOOL_GRANT_SIGNING_SECRET", "tool_grant_signing_secret", "TOOL_GRANT_SIGNING_SECRET", "dev-tool-grant-signing-secret-min-32-chars!!"),
        "MCP_COMMAND_EXECUTION_MODE": pick("MCP_COMMAND_EXECUTION_MODE", "mcp_command_execution_mode", "MCP_COMMAND_EXECUTION_MODE", "container"),
        "MCP_RUNNER_URL": pick("MCP_RUNNER_URL", "mcp_runner_url", "MCP_RUNNER_URL", "http://mcp-sandbox-runner:7110"),
        "MCP_RUNNER_TOKEN": pick("MCP_RUNNER_TOKEN", "mcp_runner_token", "MCP_RUNNER_TOKEN", "dev-mcp-runner-token-min-16-chars"),
        "MCP_RUNNER_HOST_WORKSPACE_PATH": absolute_local_path(runner_host_workspace),
        "MCP_RUNNER_DEFAULT_IMAGE": pick("MCP_RUNNER_DEFAULT_IMAGE", "mcp_runner_default_image", "MCP_RUNNER_DEFAULT_IMAGE", "node:20-alpine"),
        "MCP_RUNNER_IMAGE_MAP_JSON": runner_image_map_json,
        "MCP_RUNNER_NETWORK_MODE": pick("MCP_RUNNER_NETWORK_MODE", "mcp_runner_network_mode", "MCP_RUNNER_NETWORK_MODE", "none"),
        "MCP_LLM_PROVIDER": llm_provider,
        "MCP_LLM_MODEL": llm_model,
        "MCP_ALLOWED_LLM_PROVIDERS": allowed_providers,
        "MCP_LLM_PROVIDER_CONFIG_JSON": pick("MCP_LLM_PROVIDER_CONFIG_JSON", "mcp_provider_config_json", "MCP_LLM_PROVIDER_CONFIG_JSON", ""),
        "MCP_LLM_PROVIDER_CONFIG_PATH": pick("MCP_LLM_PROVIDER_CONFIG_PATH", "mcp_provider_config_path", "MCP_LLM_PROVIDER_CONFIG_PATH", ".singularity/llm-providers.json"),
        "MCP_LLM_MODEL_CATALOG_JSON": pick("MCP_LLM_MODEL_CATALOG_JSON", "mcp_model_catalog_json", "MCP_LLM_MODEL_CATALOG_JSON", ""),
        "MCP_LLM_MODEL_CATALOG_PATH": pick("MCP_LLM_MODEL_CATALOG_PATH", "mcp_model_catalog_path", "MCP_LLM_MODEL_CATALOG_PATH", ""),
        "LLM_PROVIDER": llm_provider,
        "LLM_MODEL": llm_model,
        "OPENAI_API_KEY": openai_key if llm_provider == "openai" and not copilot_only else "",
        "OPENAI_BASE_URL": openai_base_url if llm_provider == "openai" and not copilot_only else "",
        "OPENAI_DEFAULT_MODEL": llm_model if llm_provider == "openai" else "",
        "OPENAI_COMPATIBLE_API_KEY": openai_key if llm_provider == "openai" and not copilot_only else "",
        "OPENAI_COMPATIBLE_BASE_URL": openai_base_url if llm_provider == "openai" and not copilot_only else "",
        "OPENROUTER_API_KEY": openrouter_key if llm_provider == "openrouter" and not copilot_only else "",
        "OPENROUTER_BASE_URL": openrouter_base_url if llm_provider == "openrouter" and not copilot_only else "",
        "OPENROUTER_APP_NAME": "Context Fabric",
        "OPENROUTER_SITE_URL": "http://localhost:8000",
        "ANTHROPIC_API_KEY": anthropic_key if llm_provider == "anthropic" and not copilot_only else "",
        "WORKGRAPH_ANTHROPIC_API_KEY": "",
        "COPILOT_TOKEN": copilot_token if llm_provider == "copilot" or copilot_only else "",
        "COPILOT_BASE_URL": copilot_base_url if llm_provider == "copilot" or copilot_only else "",
        "COPILOT_DEFAULT_MODEL": pick("COPILOT_DEFAULT_MODEL", None, "COPILOT_DEFAULT_MODEL", llm_model if llm_provider == "copilot" else ""),
        "OLLAMA_BASE_URL": "" if copilot_only else pick("OLLAMA_BASE_URL", None, None, ""),
        "SUMMARIZER_MODEL_ALIAS": "mock",
        "MCP_SANDBOX_ROOT": sandbox_root,
        "MCP_AST_DB_PATH": pick("MCP_AST_DB_PATH", None, "MCP_AST_DB_PATH", f"{sandbox_root.rstrip('/')}/.singularity/mcp-ast.sqlite"),
        "MCP_AST_MAX_FILE_BYTES": pick("MCP_AST_MAX_FILE_BYTES", None, "MCP_AST_MAX_FILE_BYTES", "200000"),
        "MCP_AST_MAX_WORKSPACE_BYTES": pick("MCP_AST_MAX_WORKSPACE_BYTES", None, "MCP_AST_MAX_WORKSPACE_BYTES", "24000000"),
        "MCP_AST_MAX_SYMBOLS": pick("MCP_AST_MAX_SYMBOLS", None, "MCP_AST_MAX_SYMBOLS", "250000"),
        "MCP_WORK_BRANCH_PREFIX": pick("MCP_WORK_BRANCH_PREFIX", None, "MCP_WORK_BRANCH_PREFIX", "sg"),
        "MCP_GIT_PUSH_ENABLED": git_push_enabled,
        "MCP_GIT_AUTH_MODE": git_auth_mode,
        "MCP_GIT_PUSH_REMOTE": git_remote,
        "MCP_GIT_TOKEN_ENV": git_token_env,
        "MCP_GIT_TOKEN": git_token,
        "MCP_GIT_SSH_KEY_HOST_PATH": git_ssh_key_host_path,
        "MCP_GIT_SSH_KEY_PATH": git_ssh_key_container_path,
    }


def for_docker_host(url: str) -> str:
    return url.replace("://localhost", "://host.docker.internal").replace(
        "://127.0.0.1", "://host.docker.internal"
    )


def target_envs(values: dict[str, str]) -> dict[Path, dict[str, str]]:
    return {
        ROOT / ".env": ({
            key: values[key]
            for key in [
                "APP_ENV",
                "ENVIRONMENT",
                "SINGULARITY_ENV",
                "AUTH_OPTIONAL",
                "REQUIRE_TENANT_ID",
                "TENANT_ISOLATION_MODE",
                "JWT_SECRET",
                "IAM_BASE_URL",
                "IAM_SERVICE_URL",
                "IAM_DATABASE_URL",
                "AGENT_TOOLS_DATABASE_URL",
                "WORKGRAPH_DATABASE_URL",
                "WORKGRAPH_RUNTIME_DATABASE_URL",
                "WORKGRAPH_DATABASE_URL_ADMIN",
                "LOCAL_SUPER_ADMIN_EMAIL",
                "LOCAL_SUPER_ADMIN_PASSWORD",
                "IAM_BOOTSTRAP_USERNAME",
                "IAM_BOOTSTRAP_PASSWORD",
                "CONTEXT_FABRIC_SERVICE_TOKEN",
                "AUDIT_GOV_SERVICE_TOKEN",
                "LEARNING_SERVICE_TOKEN",
                "WORKGRAPH_INTERNAL_TOKEN",
                "WORKGRAPH_EVENT_SECRET_KEY",
                "WORKGRAPH_INCOMING_EVENT_SECRETS",
                "IAM_SERVICE_TOKEN_TENANT_IDS",
                "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS",
                "WORKGRAPH_PROXY_SERVICE_TOKEN",
                "WORKGRAPH_ARTIFACT_FETCH_URL",
                "WORKGRAPH_ARTIFACT_FETCH_TOKEN",
                "PROMPT_COMPOSER_URL",
                "AGENT_RUNTIME_URL",
                "TOOL_SERVICE_URL",
                "AGENT_SERVICE_URL",
                "CONTEXT_FABRIC_URL",
                "BLUEPRINT_WORKBENCH_URL",
                "FORMAL_VERIFIER_URL",
                "FORMAL_VERIFICATION_ENABLED",
                "FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS",
                "FORMAL_VERIFICATION_MAX_TIMEOUT_MS",
                "PROVIDER_MANIFEST_SIGNATURE_MODE",
                "PROVIDER_MANIFEST_TRUSTED_KEYS",
                "PROVIDER_MANIFEST_MAX_TTL_SECONDS",
                "AGENT_SOURCE_ALLOW_PRIVATE_URLS",
                "DEFAULT_GOVERNANCE_MODE",
                "WORKGRAPH_FORCE_GOVERNED_CODING",
                "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS",
                "CF_TOOL_GRANT_ENABLED",
                "MCP_SERVER_URL",
                "MCP_DEFAULT_BASE_URL",
                "MCP_DEFAULT_BEARER_TOKEN",
                "MCP_DEFAULT_SERVER_ID",
                "MCP_DEMO_BEARER_TOKEN",
                "MCP_DEFAULT_GOVERNANCE_MODE",
                "MCP_TOOL_GRANT_MODE",
                "MCP_REQUIRE_EFFECTIVE_CAPABILITIES",
                "TOOL_GRANT_SIGNING_SECRET",
                "MCP_COMMAND_EXECUTION_MODE",
                "MCP_RUNNER_URL",
                "MCP_RUNNER_TOKEN",
                "MCP_RUNNER_HOST_WORKSPACE_PATH",
                "MCP_RUNNER_DEFAULT_IMAGE",
                "MCP_RUNNER_IMAGE_MAP_JSON",
                "MCP_RUNNER_NETWORK_MODE",
                "MCP_LLM_PROVIDER",
                "MCP_LLM_MODEL",
                "MCP_ALLOWED_LLM_PROVIDERS",
                "MCP_LLM_PROVIDER_CONFIG_JSON",
                "MCP_LLM_PROVIDER_CONFIG_PATH",
                "MCP_LLM_MODEL_CATALOG_JSON",
                "MCP_LLM_MODEL_CATALOG_PATH",
                "MCP_PUBLIC_BASE_URL",
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
                "OPENAI_DEFAULT_MODEL",
                "OPENAI_COMPATIBLE_API_KEY",
                "OPENAI_COMPATIBLE_BASE_URL",
                "OPENROUTER_API_KEY",
                "OPENROUTER_BASE_URL",
                "ANTHROPIC_API_KEY",
                "WORKGRAPH_ANTHROPIC_API_KEY",
                "COPILOT_TOKEN",
                "COPILOT_BASE_URL",
                "COPILOT_DEFAULT_MODEL",
                "OLLAMA_BASE_URL",
                "MCP_SANDBOX_ROOT",
                "MCP_AST_DB_PATH",
                "MCP_AST_MAX_FILE_BYTES",
                "MCP_AST_MAX_WORKSPACE_BYTES",
                "MCP_AST_MAX_SYMBOLS",
                "MCP_WORK_BRANCH_PREFIX",
                "MCP_GIT_PUSH_ENABLED",
                "MCP_GIT_AUTH_MODE",
                "MCP_GIT_PUSH_REMOTE",
                "MCP_GIT_TOKEN_ENV",
                "MCP_GIT_TOKEN",
                "MCP_GIT_SSH_KEY_HOST_PATH",
                "MCP_GIT_SSH_KEY_PATH",
            ]
        } | {
            # The root compose runs Context Fabric inside Docker, so the
            # default MCP route must use Docker DNS. Host-facing URLs remain
            # available as MCP_SERVER_URL and MCP_PUBLIC_BASE_URL.
            "MCP_DEFAULT_BASE_URL": "http://mcp-server:7100",
        }),
        ROOT / "singularity-iam-service/.env": {
            "APP_ENV": values["APP_ENV"],
            "ENVIRONMENT": values["ENVIRONMENT"],
            "SINGULARITY_ENV": values["SINGULARITY_ENV"],
            "DATABASE_URL": values["IAM_DATABASE_URL"],
            "JWT_SECRET": values["JWT_SECRET"],
            "LOCAL_SUPER_ADMIN_EMAIL": values["LOCAL_SUPER_ADMIN_EMAIL"],
            "LOCAL_SUPER_ADMIN_PASSWORD": values["LOCAL_SUPER_ADMIN_PASSWORD"],
        },
        ROOT / "context-fabric/.env": {
            "APP_ENV": values["APP_ENV"],
            "ENVIRONMENT": values["ENVIRONMENT"],
            "SINGULARITY_ENV": values["SINGULARITY_ENV"],
            # context-api verifies the laptop-bridge device tokens IAM signs —
            # it MUST share IAM's JWT_SECRET or every bridge connect 403s
            # ("signature mismatch"). Was missing here → compiled-in fallback.
            "JWT_SECRET": values["JWT_SECRET"],
            "REQUIRE_TENANT_ID": values["REQUIRE_TENANT_ID"],
            "DEFAULT_GOVERNANCE_MODE": values["DEFAULT_GOVERNANCE_MODE"],
            "CF_TOOL_GRANT_ENABLED": values["CF_TOOL_GRANT_ENABLED"],
            "TOOL_GRANT_SIGNING_SECRET": values["TOOL_GRANT_SIGNING_SECRET"],
            "LLM_GATEWAY_URL": "http://llm-gateway:8001",
            "CONTEXT_MEMORY_URL": "http://context-memory-service:8002",
            "METRICS_LEDGER_URL": "http://metrics-ledger-service:8003",
            "COMPOSER_URL": for_docker_host(values["PROMPT_COMPOSER_URL"]),
            "TOOL_SERVICE_URL": for_docker_host(values["TOOL_SERVICE_URL"]),
            "IAM_BASE_URL": for_docker_host(values["IAM_BASE_URL"]),
            "IAM_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
            "IAM_SERVICE_TOKEN_TENANT_IDS": values["IAM_SERVICE_TOKEN_TENANT_IDS"],
            "MCP_DEFAULT_BASE_URL": for_docker_host(values["MCP_SERVER_URL"]),
            "MCP_DEFAULT_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "MCP_DEFAULT_SERVER_ID": values["MCP_DEFAULT_SERVER_ID"],
            "OPENROUTER_API_KEY": values["OPENROUTER_API_KEY"],
            "OPENROUTER_BASE_URL": values["OPENROUTER_BASE_URL"],
            "OPENROUTER_APP_NAME": values["OPENROUTER_APP_NAME"],
            "OPENROUTER_SITE_URL": values["OPENROUTER_SITE_URL"],
            "OPENAI_COMPATIBLE_API_KEY": values["OPENAI_COMPATIBLE_API_KEY"],
            "OPENAI_COMPATIBLE_BASE_URL": values["OPENAI_COMPATIBLE_BASE_URL"],
            "ANTHROPIC_API_KEY": values["ANTHROPIC_API_KEY"],
            "COPILOT_TOKEN": values["COPILOT_TOKEN"],
            "COPILOT_BASE_URL": values["COPILOT_BASE_URL"],
            "COPILOT_DEFAULT_MODEL": values["COPILOT_DEFAULT_MODEL"],
            "OLLAMA_BASE_URL": values["OLLAMA_BASE_URL"],
            "SUMMARIZER_MODEL_ALIAS": values["SUMMARIZER_MODEL_ALIAS"],
            "LLM_GATEWAY_INTERNAL_URL": "http://llm-gateway:8001",
        },
        ROOT / "mcp-server/.env": {
            "NODE_ENV": "development",
            "APP_ENV": values["APP_ENV"],
            "ENVIRONMENT": values["ENVIRONMENT"],
            "SINGULARITY_ENV": values["SINGULARITY_ENV"],
            "PORT": "7100",
            "MCP_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "MCP_DEFAULT_GOVERNANCE_MODE": values["MCP_DEFAULT_GOVERNANCE_MODE"],
            "MCP_TOOL_GRANT_MODE": values["MCP_TOOL_GRANT_MODE"],
            "MCP_REQUIRE_EFFECTIVE_CAPABILITIES": values["MCP_REQUIRE_EFFECTIVE_CAPABILITIES"],
            "TOOL_GRANT_SIGNING_SECRET": values["TOOL_GRANT_SIGNING_SECRET"],
            # Display/introspection only; runtime LLM calls go through
            # LLM_GATEWAY_URL and never receive provider credentials.
            "LLM_PROVIDER": values["LLM_PROVIDER"],
            "LLM_MODEL": values["LLM_MODEL"],
            "MCP_ALLOWED_LLM_PROVIDERS": values["MCP_ALLOWED_LLM_PROVIDERS"],
            "MCP_LLM_PROVIDER_CONFIG_JSON": values["MCP_LLM_PROVIDER_CONFIG_JSON"],
            "MCP_LLM_PROVIDER_CONFIG_PATH": values["MCP_LLM_PROVIDER_CONFIG_PATH"],
            "MCP_LLM_MODEL_CATALOG_JSON": values["MCP_LLM_MODEL_CATALOG_JSON"],
            "MCP_LLM_MODEL_CATALOG_PATH": values["MCP_LLM_MODEL_CATALOG_PATH"],
            "LLM_GATEWAY_URL": "http://localhost:8001",
            "LLM_GATEWAY_BEARER": values.get("LLM_GATEWAY_BEARER", ""),
            # Explicitly own and blank provider egress knobs in MCP. MCP must
            # call the central gateway by model alias, never a provider URL.
            "OPENAI_API_KEY": values["OPENAI_API_KEY"],
            "OPENAI_BASE_URL": values["OPENAI_BASE_URL"],
            "OPENAI_COMPATIBLE_API_KEY": values["OPENAI_COMPATIBLE_API_KEY"],
            "OPENAI_COMPATIBLE_BASE_URL": values["OPENAI_COMPATIBLE_BASE_URL"],
            "OPENROUTER_API_KEY": values["OPENROUTER_API_KEY"],
            "OPENROUTER_BASE_URL": values["OPENROUTER_BASE_URL"],
            "ANTHROPIC_API_KEY": values["ANTHROPIC_API_KEY"],
            "OLLAMA_BASE_URL": values["OLLAMA_BASE_URL"],
            "MCP_SANDBOX_ROOT": values["MCP_SANDBOX_ROOT"],
            "MCP_COMMAND_EXECUTION_MODE": values["MCP_COMMAND_EXECUTION_MODE"],
            "MCP_RUNNER_URL": values["MCP_RUNNER_URL"],
            "MCP_RUNNER_TOKEN": values["MCP_RUNNER_TOKEN"],
            "MCP_RUNNER_HOST_WORKSPACE_PATH": values["MCP_RUNNER_HOST_WORKSPACE_PATH"],
            "MCP_RUNNER_DEFAULT_IMAGE": values["MCP_RUNNER_DEFAULT_IMAGE"],
            "MCP_RUNNER_IMAGE_MAP_JSON": values["MCP_RUNNER_IMAGE_MAP_JSON"],
            "MCP_RUNNER_NETWORK_MODE": values["MCP_RUNNER_NETWORK_MODE"],
            "MCP_AST_DB_PATH": values["MCP_AST_DB_PATH"],
            "MCP_AST_MAX_FILE_BYTES": values["MCP_AST_MAX_FILE_BYTES"],
            "MCP_AST_MAX_WORKSPACE_BYTES": values["MCP_AST_MAX_WORKSPACE_BYTES"],
            "MCP_AST_MAX_SYMBOLS": values["MCP_AST_MAX_SYMBOLS"],
            "MCP_WORK_BRANCH_PREFIX": values["MCP_WORK_BRANCH_PREFIX"],
            "MCP_GIT_PUSH_ENABLED": values["MCP_GIT_PUSH_ENABLED"],
            "MCP_GIT_AUTH_MODE": values["MCP_GIT_AUTH_MODE"],
            "MCP_GIT_PUSH_REMOTE": values["MCP_GIT_PUSH_REMOTE"],
            "MCP_GIT_TOKEN_ENV": values["MCP_GIT_TOKEN_ENV"],
            "MCP_GIT_TOKEN": values["MCP_GIT_TOKEN"],
            "MCP_GIT_SSH_KEY_PATH": values["MCP_GIT_SSH_KEY_PATH"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "CONTEXT_FABRIC_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
        },
        ROOT / "workgraph-studio/apps/api/.env": {
            "NODE_ENV": "development",
            "APP_ENV": values["APP_ENV"],
            "ENVIRONMENT": values["ENVIRONMENT"],
            "SINGULARITY_ENV": values["SINGULARITY_ENV"],
            "PORT": "8080",
            "DATABASE_URL": values["WORKGRAPH_RUNTIME_DATABASE_URL"],
            "WORKGRAPH_RUNTIME_DATABASE_URL": values["WORKGRAPH_RUNTIME_DATABASE_URL"],
            "WORKGRAPH_DATABASE_URL_ADMIN": values["WORKGRAPH_DATABASE_URL_ADMIN"],
            "JWT_SECRET": values["JWT_SECRET"],
            "AUTH_PROVIDER": "iam",
            "TENANT_ISOLATION_MODE": values["TENANT_ISOLATION_MODE"],
            "DEFAULT_GOVERNANCE_MODE": values["DEFAULT_GOVERNANCE_MODE"],
            "WORKGRAPH_FORCE_GOVERNED_CODING": values["WORKGRAPH_FORCE_GOVERNED_CODING"],
            "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS": values["CONTEXT_FABRIC_GOVERN_SIDE_CALLERS"],
            "IAM_BASE_URL": values["IAM_BASE_URL"],
            "PROMPT_COMPOSER_URL": values["PROMPT_COMPOSER_URL"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "CONTEXT_FABRIC_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
            "MCP_SERVER_URL": values["MCP_SERVER_URL"],
            "MCP_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "MCP_TOOL_GRANT_MODE": values["MCP_TOOL_GRANT_MODE"],
            "MCP_REQUIRE_EFFECTIVE_CAPABILITIES": values["MCP_REQUIRE_EFFECTIVE_CAPABILITIES"],
            "FORMAL_VERIFIER_URL": values["FORMAL_VERIFIER_URL"],
            "FORMAL_VERIFICATION_ENABLED": values["FORMAL_VERIFICATION_ENABLED"],
            "TOOL_SERVICE_URL": values["TOOL_SERVICE_URL"],
            "AGENT_RUNTIME_URL": values["AGENT_RUNTIME_URL"],
            "WORKGRAPH_INTERNAL_TOKEN": values["WORKGRAPH_INTERNAL_TOKEN"],
            "WORKGRAPH_EVENT_SECRET_KEY": values["WORKGRAPH_EVENT_SECRET_KEY"],
            "IAM_SERVICE_TOKEN_TENANT_IDS": values["IAM_SERVICE_TOKEN_TENANT_IDS"],
            "WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS": values["WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS"],
            "MINIO_ENDPOINT": "localhost",
            "MINIO_PORT": "9000",
            "MINIO_USE_SSL": "false",
            "MINIO_ACCESS_KEY": "workgraph",
            "MINIO_SECRET_KEY": "workgraph_secret",
            "MINIO_BUCKET": "workgraph-documents",
        },
        ROOT / "workgraph-studio/apps/web/.env.local": {
            "VITE_AUTH_PROVIDER": "iam",
            "VITE_IAM_LOGIN_URL": "http://localhost:5180/identity",
            "VITE_IAM_BASE_URL": values["IAM_BASE_URL"],
            "VITE_PSEUDO_IAM_URL": "http://localhost:8101/api/v1",
            "VITE_BLUEPRINT_WORKBENCH_URL": values["BLUEPRINT_WORKBENCH_URL"],
            "VITE_AUTO_LOGIN": "0",
        },
        ROOT / "agent-and-tools/.env": {
            "APP_ENV": values["APP_ENV"],
            "ENVIRONMENT": values["ENVIRONMENT"],
            "SINGULARITY_ENV": values["SINGULARITY_ENV"],
            "AUTH_OPTIONAL": values["AUTH_OPTIONAL"],
            "DATABASE_URL": values["AGENT_TOOLS_DATABASE_URL"],
            "JWT_SECRET": values["JWT_SECRET"],
            "IAM_SERVICE_URL": values["IAM_SERVICE_URL"],
            "IAM_BASE_URL": values["IAM_BASE_URL"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "CONTEXT_FABRIC_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
            "MCP_SERVER_URL": values["MCP_SERVER_URL"],
            "MCP_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "NEXT_PUBLIC_AGENT_SERVICE_URL": values["AGENT_SERVICE_URL"],
            "NEXT_PUBLIC_TOOL_SERVICE_URL": values["TOOL_SERVICE_URL"],
            "NEXT_PUBLIC_AGENT_RUNTIME_URL": values["AGENT_RUNTIME_URL"],
            "NEXT_PUBLIC_PROMPT_COMPOSER_URL": values["PROMPT_COMPOSER_URL"],
            "WORKGRAPH_ARTIFACT_FETCH_URL": values["WORKGRAPH_ARTIFACT_FETCH_URL"],
            "WORKGRAPH_ARTIFACT_FETCH_TOKEN": values["WORKGRAPH_ARTIFACT_FETCH_TOKEN"],
            "WORKGRAPH_PROXY_SERVICE_TOKEN": values["WORKGRAPH_PROXY_SERVICE_TOKEN"],
            "PROVIDER_MANIFEST_SIGNATURE_MODE": values["PROVIDER_MANIFEST_SIGNATURE_MODE"],
            "PROVIDER_MANIFEST_TRUSTED_KEYS": values["PROVIDER_MANIFEST_TRUSTED_KEYS"],
            "PROVIDER_MANIFEST_MAX_TTL_SECONDS": values["PROVIDER_MANIFEST_MAX_TTL_SECONDS"],
            "AGENT_SOURCE_ALLOW_PRIVATE_URLS": values["AGENT_SOURCE_ALLOW_PRIVATE_URLS"],
            "DEFAULT_GOVERNANCE_MODE": values["DEFAULT_GOVERNANCE_MODE"],
            "WORKGRAPH_FORCE_GOVERNED_CODING": values["WORKGRAPH_FORCE_GOVERNED_CODING"],
            "CONTEXT_FABRIC_GOVERN_SIDE_CALLERS": values["CONTEXT_FABRIC_GOVERN_SIDE_CALLERS"],
            "CF_TOOL_GRANT_ENABLED": values["CF_TOOL_GRANT_ENABLED"],
            "TOOL_SERVER_ENDPOINT_ALLOWLIST": values["TOOL_SERVER_ENDPOINT_ALLOWLIST"],
            "TOOL_GRANT_SIGNING_SECRET": values["TOOL_GRANT_SIGNING_SECRET"],
        },
        ROOT / "singularity-portal/.env.local": {
            "VITE_IAM_BASE_URL": values["IAM_BASE_URL"],
            "VITE_WORKGRAPH_BASE_URL": "http://localhost:8080/api",
            "VITE_COMPOSER_BASE_URL": "http://localhost:3004/api/v1",
            "VITE_CONTEXT_FABRIC_BASE_URL": values["CONTEXT_FABRIC_URL"],
            "VITE_MCP_BASE_URL": values["MCP_SERVER_URL"],
            "VITE_LINK_AGENT_ADMIN": "http://localhost:5180/agents",
            "VITE_LINK_IAM_ADMIN": "http://localhost:5180/identity",
            "VITE_LINK_WORKGRAPH_DESIGNER": "http://localhost:5180/workflows",
            "VITE_LINK_BLUEPRINT_WORKBENCH": values["BLUEPRINT_WORKBENCH_URL"],
            "VITE_LINK_CODE_FOUNDRY": "http://localhost:5180/foundry",
            "VITE_API_MODE": "proxy",
        },
        ROOT / "UserAndCapabillity/.env.local": {
            "VITE_IAM_BASE_URL": values["IAM_BASE_URL"],
            "VITE_CONTEXT_FABRIC_BASE_URL": values["CONTEXT_FABRIC_URL"],
            "VITE_WORKGRAPH_BASE_URL": "http://localhost:8080/api",
        },
    }


def command_write(args: argparse.Namespace) -> None:
    values = default_values(args)
    for path, updates in target_envs(values).items():
        write_env(path, updates, dry_run=getattr(args, "dry_run", False))
    if getattr(args, "dry_run", False):
        return
    print("\nDone. Reload affected containers after env changes:")
    print("  ./singularity.sh restart context-api")
    print("  ./singularity.sh restart llm-gateway")
    print("  ./singularity.sh recreate mcp-server   # M101: reads its env_file — needs recreate, not restart")
    print("  ./singularity.sh restart formal-verifier")
    print("  ./singularity.sh restart workgraph-api")
    print("  ./singularity.sh recreate platform-web")


def command_init(args: argparse.Namespace) -> None:
    data = config_template(args.profile, args)
    write_local_config(data, force=args.force)
    if args.no_write:
        print("\nConfig profile created. Write env files when ready:")
        print("  ./singularity.sh config export")
        print("  ./singularity.sh config write")
        return
    command_write(args)
    if args.profile in COPILOT_ONLY_PROFILES:
        args.path = ".singularity/llm-models.json"
        args.default_alias = "copilot"
        args.copilot_only = True
        args.copilot_model = getattr(args, "llm_model", None) or "gpt-4o"
        command_mcp_catalog(args)
    print("\nNext:")
    if args.profile in COPILOT_ONLY_PROFILES:
        print("  cd mcp-server && npm run build && npx singularity-mcp doctor")
    else:
        print("  ./singularity.sh config mcp-catalog --default-alias mock")
    print("  ./singularity.sh doctor")


def command_set(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    if args.key not in CONFIG_KEY_MAP:
        known = ", ".join(sorted(CONFIG_KEY_MAP))
        raise SystemExit(f"Unknown config key: {args.key}\nKnown keys: {known}")
    set_path(data, args.key, args.value)
    write_local_config(data, force=True)
    if not args.no_write:
        command_write(args)


def command_rotate_secrets(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    rotated: list[tuple[str, str]] = []

    def rotate(dotted: str, prefix: str, *, bytes_len: int = 32) -> None:
        value = strong_secret(prefix, bytes_len=bytes_len)
        set_path(data, dotted, value)
        rotated.append((dotted, value))

    rotate("identity.jwtSecret", "jwt")
    rotate("tokens.contextFabricServiceToken", "cfsvc")
    rotate("tokens.auditGovServiceToken", "auditsvc")
    rotate("tokens.learningServiceToken", "learnsvc")
    rotate("tokens.workgraphInternalToken", "wgsvc")
    rotate("tokens.workgraphEventSecretKey", "wgeventkey")
    incoming_event_secrets = {
        "agent-runtime": strong_secret("wgevt-agent-runtime"),
        "agent-service": strong_secret("wgevt-agent-service"),
        "tool-service": strong_secret("wgevt-tool-service"),
        "iam": strong_secret("wgevt-iam"),
    }
    set_path(data, "tokens.workgraphIncomingEventSecrets", json.dumps(incoming_event_secrets, separators=(",", ":")))
    rotated.append(("tokens.workgraphIncomingEventSecrets", "<rotated JSON map>"))
    rotate("mcpRuntime.bearerToken", "mcp")
    rotate("mcpRuntime.runnerToken", "mcprunner")
    rotate("mcpRuntime.toolGrantSigningSecret", "toolgrant")

    if getattr(args, "provider_manifest_key_id", None):
        key_id = args.provider_manifest_key_id
        key_secret = strong_secret("manifest", bytes_len=32)
        set_path(data, "agentRuntime.providerManifestSignatureMode", "required")
        set_path(data, "agentRuntime.providerManifestTrustedKeys", json.dumps({key_id: key_secret}, separators=(",", ":")))
        rotated.append((f"agentRuntime.providerManifestTrustedKeys.{key_id}", key_secret))

    if getattr(args, "include_bootstrap_password", False):
        rotate("identity.bootstrapPassword", "admin", bytes_len=24)

    write_local_config(data, force=True)
    if not getattr(args, "no_write", False):
        command_write(args)

    print("\nRotated local secrets:")
    for dotted, value in rotated:
        env_key = CONFIG_KEY_MAP.get(dotted, dotted)
        print(f"  {dotted:<45} {mask(env_key, value)}")
    print("\nNext:")
    print("  ./singularity.sh recreate platform-core")
    print("  ./singularity.sh restart iam-service")
    print("  ./singularity.sh restart context-api")
    print("  Mint WORKGRAPH_PROXY_SERVICE_TOKEN through IAM before production deploy; it must be an IAM service JWT, not a random secret.")
    print("  ./singularity.sh restart workgraph-api")
    print("  ./singularity.sh restart platform-web")
    print("  ./singularity.sh doctor secrets")
    if not getattr(args, "include_bootstrap_password", False):
        print("  Bootstrap admin password was left unchanged. Add --include-bootstrap-password only before first boot or after resetting the IAM user password.")


def post_json(url: str, payload: dict, *, bearer_token: str | None = None, timeout: float = 10.0) -> dict:
    headers = {"content-type": "application/json", "user-agent": "singularity-config"}
    if bearer_token:
        headers["authorization"] = f"Bearer {bearer_token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise SystemExit(f"IAM request failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"IAM request failed: {exc}") from exc


def command_mint_workgraph_proxy_token(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", argparse.Namespace())
    iam_base = (
        args.iam_base_url
        or str(get_path(data, "identity.iamBaseUrl") or "")
        or "http://localhost:8100/api/v1"
    ).rstrip("/")
    admin_token = args.admin_token or os.getenv("IAM_ADMIN_TOKEN") or ""
    email = args.email or str(get_path(data, "identity.bootstrapEmail") or "admin@singularity.local")
    password = args.password or str(get_path(data, "identity.bootstrapPassword") or "")

    tenant_inputs = args.tenant_id or []
    if not tenant_inputs:
        configured = str(get_path(data, "tokens.iamServiceTokenTenantIds") or "")
        if configured:
            tenant_inputs = [configured]
    tenant_ids = normalize_tenant_ids(tenant_inputs) if tenant_inputs else []
    if not tenant_ids and local_config_prod_like(data):
        raise SystemExit(
            "Production-class config requires tenant-scoped service tokens. "
            "Run `./singularity.sh config production-guardrails --tenant-id <tenant>` first, "
            "or pass --tenant-id explicitly."
        )

    if not admin_token:
        if not password:
            raise SystemExit("Missing bootstrap password. Pass --admin-token or --password.")
        login = post_json(f"{iam_base}/auth/local/login", {"email": email, "password": password})
        admin_token = str(login.get("access_token") or "")
        if not admin_token:
            raise SystemExit("IAM login succeeded but did not return access_token.")

    payload = {
        "service_name": "platform-web",
        "scopes": ["read:reference-data", "read:mcp-servers", "publish:events"],
        "tenant_ids": tenant_ids,
        "ttl_hours": args.ttl_hours,
    }
    minted = post_json(f"{iam_base}/auth/service-token", payload, bearer_token=admin_token)
    token = str(minted.get("access_token") or "")
    if not looks_like_jwt(token):
        raise SystemExit("IAM did not return a JWT-shaped service token.")

    set_path(data, "platform.workgraphProxyServiceToken", token)
    write_local_config(data, force=True)
    if not args.no_write:
        command_write(args)

    if not tenant_ids:
        print("WARN minted platform-web service token without tenant_ids; use --tenant-id for strict/shared deployments.")
    print("Minted WORKGRAPH_PROXY_SERVICE_TOKEN for platform-web.")
    print(f"  token: {mask('WORKGRAPH_PROXY_SERVICE_TOKEN', token)}")
    print(f"  tenant_ids: {','.join(tenant_ids) if tenant_ids else '(none)'}")
    print(f"  ttl_hours: {args.ttl_hours}")
    print("\nNext:")
    print("  ./singularity.sh recreate platform-web")
    print("  ./singularity.sh doctor")


def command_production_guardrails(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    tenant_ids = normalize_tenant_ids(args.tenant_id)
    tenant_scope = ",".join(tenant_ids)
    env_name = args.env
    updates: list[tuple[str, object]] = [
        ("platform.appEnv", env_name),
        ("platform.environment", env_name),
        ("platform.singularityEnv", env_name),
        ("platform.authOptional", False),
        ("platform.requireTenantId", True),
        ("platform.tenantIsolationMode", "strict"),
        ("tokens.iamServiceTokenTenantIds", tenant_scope),
        ("tokens.workgraphInternalTokenTenantIds", tenant_scope),
        ("agentRuntime.providerManifestSignatureMode", args.provider_manifest_signature_mode),
        ("contextFabric.defaultGovernanceMode", "fail_closed"),
        ("contextFabric.toolGrantEnabled", True),
        ("mcpRuntime.defaultGovernanceMode", "fail_closed"),
        ("mcpRuntime.toolGrantMode", "enforce"),
        ("mcpRuntime.requireEffectiveCapabilities", True),
    ]

    print("Production guardrail updates:")
    for dotted, value in updates:
        env_key = CONFIG_KEY_MAP.get(dotted, dotted)
        printable = "true" if value is True else "false" if value is False else str(value)
        print(f"  {dotted:<48} {mask(env_key, printable)}")

    if getattr(args, "dry_run", False):
        print("\nDry run only. No files were changed.")
    else:
        for dotted, value in updates:
            set_path(data, dotted, value)
        write_local_config(data, force=True)
        if not getattr(args, "no_write", False):
            command_write(args)
        else:
            print("\nCanonical config updated. Write env files when ready:")
            print("  ./singularity.sh config write")

    print("\nNext:")
    print("  ./singularity.sh config rotate-secrets --provider-manifest-key-id platform-prod")
    print("  # Backfill any legacy rows before enabling forced RLS:")
    print('  bin/backfill-workgraph-tenant-ids.py --database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply')
    print("  # Then enable the production database enforcement gate:")
    print('  bin/enable-workgraph-forced-rls.py --database-url "$WORKGRAPH_RUNTIME_DATABASE_URL" --admin-database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply --confirm-strict-runtime')
    print(f"  APP_ENV={env_name} SINGULARITY_ENV={env_name} ENVIRONMENT={env_name} ./singularity.sh doctor")


def command_prepare_production(args: argparse.Namespace) -> None:
    tenant_ids = normalize_tenant_ids(args.tenant_id)
    tenant_scope = ",".join(tenant_ids)
    provider_key_id = args.provider_manifest_key_id or "platform-prod"
    rotate_secrets = not args.skip_rotate_secrets
    mint_now = not args.skip_mint_workgraph_proxy_token and not rotate_secrets
    mint_deferred = not args.skip_mint_workgraph_proxy_token and rotate_secrets
    preflight_now = not args.skip_preflight and not rotate_secrets

    print("Production preparation plan:")
    print(f"  env: {args.env}")
    print(f"  tenant_ids: {tenant_scope}")
    print(f"  provider_manifest_key_id: {provider_key_id}")
    print(f"  rotate_secrets: {'no' if args.skip_rotate_secrets else 'yes'}")
    print(f"  rotate_bootstrap_password: {'yes' if args.include_bootstrap_password and rotate_secrets else 'no'}")
    print(f"  mint_workgraph_proxy_token: {'deferred until IAM restart' if mint_deferred else 'yes' if mint_now else 'no'}")
    print(f"  deploy_preflight: {'yes' if preflight_now else 'deferred until token mint' if rotate_secrets and not args.skip_preflight else 'no'}")

    if args.dry_run:
        print("\nDry run only. No files were changed.")
        print("\nEquivalent commands:")
        tenant_flags = " ".join(f"--tenant-id {shlex.quote(item)}" for item in tenant_ids)
        if rotate_secrets:
            print(
                "  ./singularity.sh config production-guardrails "
                f"{tenant_flags} --env {shlex.quote(args.env)} "
                f"--provider-manifest-signature-mode {shlex.quote(args.provider_manifest_signature_mode)}"
            )
            rotate = f"  ./singularity.sh config rotate-secrets --provider-manifest-key-id {shlex.quote(provider_key_id)}"
            if args.include_bootstrap_password:
                rotate += " --include-bootstrap-password"
            print(rotate)
            print("  ./singularity.sh recreate iam-service")
            if args.include_bootstrap_password:
                print("  ./singularity.sh config reset-bootstrap-password")
            rerun = "  ./singularity.sh config prepare-production " + tenant_flags + " --skip-rotate-secrets"
            if args.skip_mint_workgraph_proxy_token:
                rerun += " --skip-mint-workgraph-proxy-token"
            if args.skip_preflight:
                rerun += " --skip-preflight"
            print(rerun)
        else:
            mint = "  ./singularity.sh config mint-workgraph-proxy-token " + tenant_flags
            if args.iam_base_url:
                mint += f" --iam-base-url {shlex.quote(args.iam_base_url)}"
            if args.admin_token:
                mint += " --admin-token <redacted>"
            if not args.skip_mint_workgraph_proxy_token:
                print(mint)
            if not args.skip_preflight:
                print("  bin/check-deploy-env.sh --config-only")
        print("\nDatabase enforcement remains explicit:")
        print('  bin/backfill-workgraph-tenant-ids.py --database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply')
        print('  bin/enable-workgraph-forced-rls.py --database-url "$WORKGRAPH_RUNTIME_DATABASE_URL" --admin-database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply --confirm-strict-runtime')
        return

    if rotate_secrets:
        print("\n[1/4] Writing production guardrails...")
        command_production_guardrails(argparse.Namespace(
            tenant_id=tenant_ids,
            env=args.env,
            provider_manifest_signature_mode=args.provider_manifest_signature_mode,
            dry_run=False,
            no_write=args.no_write,
        ))

        print("\n[2/4] Rotating production secrets...")
        command_rotate_secrets(argparse.Namespace(
            provider_manifest_key_id=provider_key_id,
            include_bootstrap_password=args.include_bootstrap_password,
            no_write=args.no_write,
        ))

        print("\n[3/4] Deferring WORKGRAPH_PROXY_SERVICE_TOKEN mint until IAM runs with the new JWT secret.")
        print("      Restart or deploy iam-service with the generated env before minting the platform-web service token:")
        print("        ./singularity.sh recreate iam-service")
        if args.include_bootstrap_password:
            print("        ./singularity.sh config reset-bootstrap-password")
        tenant_flags = " ".join(f"--tenant-id {shlex.quote(item)}" for item in tenant_ids)
        rerun = "        ./singularity.sh config prepare-production " + tenant_flags + " --skip-rotate-secrets"
        if args.skip_mint_workgraph_proxy_token:
            rerun += " --skip-mint-workgraph-proxy-token"
        if args.skip_preflight:
            rerun += " --skip-preflight"
        print(rerun)
        print("\n[4/4] Deploy preflight deferred until after tenant-scoped Workgraph proxy token mint.")
        return

    print("\n[1/4] Reusing existing production guardrails and rotated secrets (--skip-rotate-secrets).")
    print("      IAM is expected to be running with the current JWT/env before token minting.")

    if args.skip_mint_workgraph_proxy_token:
        print("\n[2/4] Skipping WORKGRAPH_PROXY_SERVICE_TOKEN mint by request.")
        print("      Run ./singularity.sh config mint-workgraph-proxy-token before deployment.")
    else:
        print("\n[2/4] Minting tenant-scoped WORKGRAPH_PROXY_SERVICE_TOKEN...")
        command_mint_workgraph_proxy_token(argparse.Namespace(
            tenant_id=tenant_ids,
            ttl_hours=args.ttl_hours,
            iam_base_url=args.iam_base_url,
            admin_token=args.admin_token,
            email=args.email,
            password=args.password,
            no_write=args.no_write,
        ))

    if args.skip_preflight:
        print("\n[3/4] Skipping deploy preflight by request.")
    elif args.no_write:
        print("\n[3/4] Skipping deploy preflight because --no-write left env files unchanged.")
        print("      Run ./singularity.sh config write, then bin/check-deploy-env.sh --config-only.")
    else:
        print("\n[3/4] Running deploy preflight...")
        env = os.environ.copy()
        env.update({"APP_ENV": args.env, "ENVIRONMENT": args.env, "SINGULARITY_ENV": args.env})
        result = subprocess.run(
            ["bash", "bin/check-deploy-env.sh", "--config-only"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            env=env,
        )
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            raise SystemExit(result.returncode)

    print("\nProduction preparation complete.")
    print("Before release, explicitly verify database enforcement if this target uses shared Workgraph tables:")
    print('  bin/backfill-workgraph-tenant-ids.py --database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply')
    print('  bin/enable-workgraph-forced-rls.py --database-url "$WORKGRAPH_RUNTIME_DATABASE_URL" --admin-database-url "$WORKGRAPH_DATABASE_URL_ADMIN" --apply --confirm-strict-runtime')


IAM_BOOTSTRAP_PASSWORD_RESET_SCRIPT = r'''
import asyncio
import os
import sys
from sqlalchemy import text
from app.auth.password import hash_password
from app.database import AsyncSessionLocal


async def main() -> int:
    email = os.getenv("LOCAL_SUPER_ADMIN_EMAIL", "admin@singularity.local").strip().lower()
    password = os.getenv("LOCAL_SUPER_ADMIN_PASSWORD", "")
    if not password:
        print("LOCAL_SUPER_ADMIN_PASSWORD is not set in iam-service", file=sys.stderr)
        return 2
    password_hash = hash_password(password)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            text(
                """
                UPDATE iam.local_credentials AS cred
                   SET password_hash = :password_hash,
                       password_changed_at = now()
                  FROM iam.users AS users
                 WHERE cred.user_id = users.id
                   AND lower(users.email) = :email
                   AND users.is_local_account = true
                """
            ),
            {"email": email, "password_hash": password_hash},
        )
        await db.commit()
    if result.rowcount != 1:
        print(f"expected to update 1 local credential for {email}, updated {result.rowcount}", file=sys.stderr)
        return 1
    print(f"reset bootstrap IAM password hash for {email}")
    return 0


raise SystemExit(asyncio.run(main()))
'''


def command_reset_bootstrap_password(args: argparse.Namespace) -> None:
    data = load_local_config()
    email = str(get_path(data, "identity.bootstrapEmail") or "admin@singularity.local")
    password = str(get_path(data, "identity.bootstrapPassword") or "")
    if not password:
        raise SystemExit("identity.bootstrapPassword is empty in .singularity/config.local.json")

    cmd = ["docker", "compose", "exec", "-T", "iam-service", "python", "-"]
    env = os.environ.copy()
    result = subprocess.run(
        cmd,
        cwd=ROOT,
        input=IAM_BOOTSTRAP_PASSWORD_RESET_SCRIPT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    print(result.stdout.strip())
    print(f"Bootstrap login now uses {email} with the password stored in .singularity/config.local.json.")
    print("Run ./singularity.sh login and ./singularity.sh doctor secrets to verify.")


def command_mcp(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    if args.base_url:
        set_path(data, "mcpRuntime.serverUrl", args.base_url)
    if args.public_base_url:
        set_path(data, "mcpRuntime.publicBaseUrl", args.public_base_url)
    if args.bearer_token:
        set_path(data, "mcpRuntime.bearerToken", args.bearer_token)
    if getattr(args, "default_governance_mode", None):
        set_path(data, "mcpRuntime.defaultGovernanceMode", args.default_governance_mode)
    if getattr(args, "tool_grant_mode", None):
        set_path(data, "mcpRuntime.toolGrantMode", args.tool_grant_mode)
    if getattr(args, "require_effective_capabilities", None) is not None:
        set_path(data, "mcpRuntime.requireEffectiveCapabilities", bool(args.require_effective_capabilities))
    if getattr(args, "tool_grant_signing_secret", None):
        set_path(data, "mcpRuntime.toolGrantSigningSecret", args.tool_grant_signing_secret)
    if args.sandbox_root:
        root = str(Path(args.sandbox_root).expanduser())
        host_root = absolute_local_path(args.sandbox_root)
        set_path(data, "mcpRuntime.sandboxRoot", root)
        set_path(data, "mcpRuntime.runnerHostWorkspacePath", host_root)
        if not args.ast_db_path:
            set_path(data, "mcpRuntime.astDbPath", f"{root.rstrip('/')}/.singularity/mcp-ast.sqlite")
    if args.ast_db_path:
        set_path(data, "mcpRuntime.astDbPath", str(Path(args.ast_db_path).expanduser()))
    if getattr(args, "command_execution_mode", None):
        set_path(data, "mcpRuntime.commandExecutionMode", args.command_execution_mode)
    if getattr(args, "runner_url", None):
        set_path(data, "mcpRuntime.runnerUrl", args.runner_url)
    if getattr(args, "runner_token", None):
        set_path(data, "mcpRuntime.runnerToken", args.runner_token)
    if getattr(args, "runner_host_workspace_path", None):
        set_path(data, "mcpRuntime.runnerHostWorkspacePath", absolute_local_path(args.runner_host_workspace_path))
    if getattr(args, "runner_default_image", None):
        set_path(data, "mcpRuntime.runnerDefaultImage", args.runner_default_image)
    if getattr(args, "runner_image_map_json", None):
        json.loads(args.runner_image_map_json)
        set_path(data, "mcpRuntime.runnerImageMapJson", args.runner_image_map_json)
    if getattr(args, "runner_network_mode", None):
        set_path(data, "mcpRuntime.runnerNetworkMode", args.runner_network_mode)
    write_local_config(data, force=True)
    command_write(args)


def command_git(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    mode = args.mode
    remote = args.remote or get_path(data, "git.remoteName") or "origin"
    enabled = mode != "disabled"
    set_path(data, "git.push.enabled", enabled)
    set_path(data, "git.auth.mode", mode)
    set_path(data, "git.remoteName", remote)
    if args.branch_prefix:
        set_path(data, "git.defaultBranchPrefix", args.branch_prefix)
        set_path(data, "mcpRuntime.workBranchPrefix", args.branch_prefix)
    if mode == "ssh":
        if not args.ssh_key:
            raise SystemExit("--ssh-key is required when --mode ssh")
        key_path = str(Path(args.ssh_key).expanduser())
        set_path(data, "git.sshKeyPath", key_path)
        set_path(data, "git.tokenEnv", get_path(data, "git.tokenEnv") or "GITHUB_TOKEN")
    elif mode == "token":
        token_env = args.token_env or "GITHUB_TOKEN"
        set_path(data, "git.tokenEnv", token_env)
        set_path(data, "git.sshKeyPath", "")
    else:
        set_path(data, "git.sshKeyPath", "")
        set_path(data, "git.tokenEnv", args.token_env or get_path(data, "git.tokenEnv") or "GITHUB_TOKEN")
    write_local_config(data, force=True)
    if not args.no_write:
        command_write(args)
    print("\nGit push credential config updated. Secrets are not stored in config.")
    if mode == "token":
        print(f"Set {args.token_env or 'GITHUB_TOKEN'} in your shell before exporting env files or starting containers.")
    print("Verify with:")
    print("  ./singularity.sh doctor git")


def mcp_provider_config_payload(*, copilot_only: bool, default_provider: str, default_model: str) -> dict:
    provider = "copilot" if copilot_only else default_provider
    if provider not in {"mock", "copilot"}:
        raise SystemExit(
            "Non-mock/non-Copilot generated provider catalogs are disabled. "
            "Edit .singularity/llm-providers.json explicitly if you need another provider."
        )
    if provider == "mock":
        providers = {
            "mock": {
                "enabled": True,
                "defaultModel": "mock-fast",
                "supportsTools": False,
                "costTier": "mock",
                "description": "Offline deterministic model for smoke tests.",
            }
        }
    else:
        providers = {
            "copilot": {
                "enabled": True,
                "baseUrl": "https://api.githubcopilot.com",
                "defaultModel": default_model,
                "credentialEnv": "COPILOT_TOKEN",
                "supportsTools": True,
                "costTier": "medium",
                "description": "GitHub Copilot provider owned by the central LLM gateway.",
            }
        }
    return {
        "defaultProvider": provider,
        "defaultModel": default_model,
        "allowedProviders": [provider],
        "providers": providers,
    }

def write_mcp_provider_config(path_value: str, payload: dict) -> Path:
    out = Path(path_value).expanduser()
    if not out.is_absolute():
        out = ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
    return out


def apply_copilot_only(
    data: dict,
    *,
    token: str | None = None,
    model: str = "gpt-4o",
    profile: str = "office-copilot-only",
) -> dict:
    data["profile"] = profile
    set_path(data, "llm.provider", "copilot")
    set_path(data, "llm.model", model)
    set_path(data, "llm.allowedProviders", "copilot")
    set_path(data, "llm.providerConfigPath", ".singularity/llm-providers.json")
    set_path(data, "llm.providerConfigJson", "")
    set_path(data, "llm.modelCatalogPath", ".singularity/llm-models.json")
    set_path(data, "llm.modelCatalogJson", "")
    set_path(data, "llm.openai.apiKey", "")
    set_path(data, "llm.openai.baseUrl", "")
    set_path(data, "llm.openrouter.apiKey", "")
    set_path(data, "llm.openrouter.baseUrl", "")
    set_path(data, "llm.anthropic.apiKey", "")
    set_path(data, "llm.ollama.baseUrl", "")
    if token is not None:
        set_path(data, "llm.copilot.token", token)
    elif get_path(data, "llm.copilot.token") is None:
        set_path(data, "llm.copilot.token", os.getenv("COPILOT_TOKEN", ""))
    set_path(data, "llm.copilot.baseUrl", "https://api.githubcopilot.com")
    set_path(data, "llm.copilot.defaultModel", model)
    return data


def command_office_copilot_only(args: argparse.Namespace) -> None:
    raise SystemExit(
        "office-copilot-only gateway mode is retired. Configure the normal mock/Anthropic/OpenAI gateway "
        "and run Copilot stages with an AGENT_TASK executor=copilot through the governed MCP runtime."
    )
def command_interactive(args: argparse.Namespace) -> None:
    print("Singularity configuration wizard\n")
    provider = prompt_choice("LLM provider", ["openai", "openrouter", "ollama", "mock"], "mock")
    args.llm_provider = provider
    args.llm_model = input_default("LLM model", "mock-fast" if provider == "mock" else "gpt-4o-mini")
    if provider == "openai":
        args.openai_api_key = getpass.getpass("OpenAI API key (blank to preserve/env): ").strip() or None
    elif provider == "openrouter":
        args.openrouter_api_key = getpass.getpass("OpenRouter API key (blank to preserve/env): ").strip() or None
    args.pseudo_iam = input_default("Use pseudo-IAM? [y/N]", "N").lower().startswith("y")
    args.mcp_bearer_token = input_default("MCP bearer token", "demo-bearer-token-must-be-min-16-chars")
    args.mcp_sandbox_root = input_default("MCP sandbox root", str(ROOT))
    args.dry_run = False
    command_write(args)


def input_default(label: str, default: str) -> str:
    value = input(f"{label} [{default}]: ").strip()
    return value or default


def prompt_choice(label: str, choices: list[str], default: str) -> str:
    while True:
        value = input_default(f"{label} ({'/'.join(choices)})", default)
        if value in choices:
            return value
        print(f"Choose one of: {', '.join(choices)}")


def command_show(_: argparse.Namespace) -> None:
    config = load_local_config()
    if config:
        print(f"{CONFIG_PATH.relative_to(ROOT)}")
        print(f"  profile{'':<24} {config.get('profile', '(unset)')}")
        for dotted, env_key in sorted(CONFIG_KEY_MAP.items()):
            value = get_path(config, dotted)
            if value is not None:
                print(f"  {dotted:<30} {mask(env_key, str(value))}")
        print("")
    files = [
        ROOT / ".env",
        ROOT / "singularity-iam-service/.env",
        ROOT / "context-fabric/.env",
        ROOT / "mcp-server/.env",
        ROOT / "workgraph-studio/apps/api/.env",
        ROOT / "workgraph-studio/apps/web/.env.local",
        ROOT / "agent-and-tools/.env",
        ROOT / "singularity-portal/.env.local",
        ROOT / "UserAndCapabillity/.env.local",
    ]
    keys = [
        "AUTH_PROVIDER",
        "IAM_BASE_URL",
        "CONTEXT_FABRIC_URL",
        "BLUEPRINT_WORKBENCH_URL",
        "PROMPT_COMPOSER_URL",
        "MCP_SERVER_URL",
        "MCP_BEARER_TOKEN",
        "WORKGRAPH_INTERNAL_TOKEN",
        "WORKGRAPH_ARTIFACT_FETCH_URL",
        "WORKGRAPH_ARTIFACT_FETCH_TOKEN",
        "MCP_LLM_PROVIDER",
        "MCP_ALLOWED_LLM_PROVIDERS",
        "LLM_PROVIDER",
        "LLM_MODEL",
        "OPENAI_API_KEY",
        "OPENAI_COMPATIBLE_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "COPILOT_TOKEN",
        "COPILOT_DEFAULT_MODEL",
        "DATABASE_URL",
        "IAM_DATABASE_URL",
        "AGENT_TOOLS_DATABASE_URL",
        "WORKGRAPH_DATABASE_URL",
        "AGENT_SERVICE_URL",
        "AGENT_RUNTIME_URL",
        "TOOL_SERVICE_URL",
        "MCP_SANDBOX_ROOT",
        "MCP_COMMAND_EXECUTION_MODE",
        "MCP_RUNNER_URL",
        "MCP_RUNNER_TOKEN",
        "MCP_RUNNER_HOST_WORKSPACE_PATH",
        "MCP_RUNNER_DEFAULT_IMAGE",
        "MCP_RUNNER_NETWORK_MODE",
        "MCP_AST_DB_PATH",
        "MCP_GIT_PUSH_ENABLED",
        "MCP_GIT_AUTH_MODE",
        "MCP_GIT_PUSH_REMOTE",
        "MCP_GIT_TOKEN_ENV",
        "MCP_GIT_TOKEN",
        "MCP_GIT_SSH_KEY_PATH",
    ]
    for path in files:
        env = parse_env(path)
        print(f"\n{path.relative_to(ROOT)}")
        if not env:
            print("  (missing or empty)")
            continue
        for key in keys:
            if key in env:
                print(f"  {key:<30} {mask(key, env[key])}")


def socket_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_check(name: str, url: str, timeout: float = 2.0, *, required: bool = True) -> tuple[str, str]:
    try:
        req = urllib.request.Request(url, headers={"user-agent": "singularity-config-doctor"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return "OK", f"{name} {res.status}"
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            return "OK", f"{name} reachable ({exc.code})"
        return "WARN", f"{name} HTTP {exc.code}"
    except Exception as exc:
        if required:
            return "FAIL", f"{name} unreachable: {exc}"
        return "WARN", f"{name} not running locally (optional/remote-capable): {exc}"


def http_json(url: str, timeout: float = 2.0, bearer_token: str | None = None) -> tuple[str, dict | None, str]:
    try:
        headers = {"user-agent": "singularity-config-doctor"}
        if bearer_token:
            headers["authorization"] = f"Bearer {bearer_token}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode()
            return "OK", json.loads(raw), f"HTTP {res.status}"
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:300]
        except Exception:
            detail = ""
        return "FAIL", None, f"HTTP {exc.code} {detail}".strip()
    except Exception as exc:
        return "FAIL", None, str(exc)


def gh_copilot_ready() -> tuple[bool, str]:
    gh = shutil.which("gh")
    if not gh:
        return False, "GitHub CLI `gh` is not installed or not on PATH"
    try:
        auth = subprocess.run([gh, "auth", "status"], capture_output=True, text=True, timeout=5)
        if auth.returncode != 0:
            return False, "`gh auth status` failed; run `gh auth login`"
        ext = subprocess.run([gh, "extension", "list"], capture_output=True, text=True, timeout=5)
        if ext.returncode != 0 or "copilot" not in ext.stdout.lower():
            return False, "GitHub Copilot CLI extension missing; run `gh extension install github/gh-copilot`"
        return True, "GitHub Copilot CLI is installed and authenticated"
    except Exception as exc:
        return False, f"Could not verify GitHub Copilot CLI: {exc}"


def write_doctor_summary(records: list[dict[str, str]], *, failures: int, warnings: int) -> None:
    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "configPath": str(CONFIG_PATH.relative_to(ROOT)),
        "summary": {"failures": failures, "warnings": warnings, "checks": len(records)},
        "checks": records,
    }
    DOCTOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    DOCTOR_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    PLATFORM_DOCTOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLATFORM_DOCTOR_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    PORTAL_DOCTOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    PORTAL_DOCTOR_PATH.write_text(json.dumps(payload, indent=2) + "\n")


def merged_env_config() -> dict[str, str]:
    merged: dict[str, str] = flatten_local_config()
    for path in [
        ROOT / ".env",
        ROOT / "singularity-iam-service/.env",
        ROOT / "context-fabric/.env",
        ROOT / "mcp-server/.env",
        ROOT / "agent-and-tools/.env",
        ROOT / "workgraph-studio/apps/api/.env",
    ]:
        merged.update(parse_env(path))
    return merged


def run_secret_doctor(record) -> None:
    guard = ROOT / "bin/check-secret-guardrails.sh"
    if not guard.exists():
        record("WARN", "secret guard script is missing", "restore bin/check-secret-guardrails.sh")
        return
    result = subprocess.run(["bash", str(guard)], cwd=ROOT, text=True, capture_output=True, check=False)
    output = (result.stderr or result.stdout or "").strip()
    if result.returncode == 0:
        warn_lines = [line for line in output.splitlines() if line.startswith("WARN ")]
        if warn_lines:
            record("WARN", f"secret guardrails passed with {len(warn_lines)} warning(s)", "./singularity.sh config rotate-secrets")
        else:
            record("OK", "secret guardrails passed")
        return
    first = output.splitlines()[0] if output else "secret guard failed"
    record("FAIL", first, "bash bin/check-secret-guardrails.sh")


def run_frontend_token_doctor(record) -> None:
    guard = ROOT / "bin/check-frontend-no-service-tokens.sh"
    if not guard.exists():
        record("WARN", "frontend token guard script is missing", "restore bin/check-frontend-no-service-tokens.sh")
        return
    result = subprocess.run(["bash", str(guard)], cwd=ROOT, text=True, capture_output=True, check=False)
    output = (result.stderr or result.stdout or "").strip()
    if result.returncode == 0:
        record("OK", "frontend service-token guard passed")
        return
    first = re.sub(r"\x1b\[[0-9;]*m", "", output.splitlines()[0]) if output else "frontend service-token guard failed"
    record("FAIL", first, "bash bin/check-frontend-no-service-tokens.sh")


def run_handbook_html_doctor(record) -> None:
    guard = ROOT / "bin/check-platform-handbook-html.sh"
    if not guard.exists():
        record("WARN", "platform handbook HTML freshness guard is missing", "restore bin/check-platform-handbook-html.sh")
        return
    result = subprocess.run(["bash", str(guard)], cwd=ROOT, text=True, capture_output=True, check=False)
    output = (result.stderr or result.stdout or "").strip()
    if result.returncode == 0:
        record("OK", "platform handbook HTML is current")
        return
    first = re.sub(r"\x1b\[[0-9;]*m", "", output.splitlines()[0]) if output else "platform handbook HTML freshness check failed"
    record("FAIL", first, "node bin/render-platform-handbook-html.mjs")


def run_smoke_with_retry(command: list[str], *, attempts: int = 8, delay_seconds: float = 3.0) -> subprocess.CompletedProcess[str]:
    """Run a startup-sensitive smoke command, retrying brief proxy/upstream races."""
    last: subprocess.CompletedProcess[str] | None = None
    for attempt in range(attempts):
        last = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if last.returncode == 0 or attempt == attempts - 1:
            return last
        time.sleep(delay_seconds)
    assert last is not None
    return last


def run_git_doctor(record, merged: dict[str, str]) -> None:
    enabled = (merged.get("MCP_GIT_PUSH_ENABLED") or "false").lower() == "true"
    mode = (merged.get("MCP_GIT_AUTH_MODE") or "disabled").lower()
    remote = merged.get("MCP_GIT_PUSH_REMOTE") or "origin"
    workspace = Path(merged.get("MCP_SANDBOX_ROOT") or str(ROOT)).expanduser()
    if not workspace.is_absolute():
        workspace = ROOT / workspace

    if enabled:
        record("OK", f"Git push is enabled ({mode})")
    else:
        record("WARN", "Git push is disabled; GIT_PUSH nodes will preserve commits but block before publishing", "./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote origin")

    if workspace.exists() and os.access(workspace, os.W_OK):
        record("OK", f"MCP workspace is writable: {workspace}")
    else:
        record("FAIL", f"MCP workspace is not writable: {workspace}", "./singularity.sh config mcp --sandbox-root <writable-path>")

    if mode == "ssh":
        key_path = merged.get("MCP_GIT_SSH_KEY_HOST_PATH") or merged.get("MCP_GIT_SSH_KEY_PATH") or ""
        if key_path and Path(key_path).expanduser().exists():
            record("OK", "Git SSH key path exists")
        elif os.getenv("SSH_AUTH_SOCK"):
            record("OK", "SSH agent socket is available")
        else:
            record("FAIL", "SSH mode selected but no SSH key path or SSH agent is available", "./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote origin")
    elif mode == "token":
        token_env = merged.get("MCP_GIT_TOKEN_ENV") or "GITHUB_TOKEN"
        if os.getenv(token_env) or merged.get("MCP_GIT_TOKEN"):
            record("OK", f"Git token env is present: {token_env}")
        else:
            record("FAIL", f"token mode selected but {token_env} is not set", f"export {token_env}=<github-token-with-repo-write>")
    elif enabled:
        record("FAIL", "Git push is enabled but git auth mode is disabled", "./singularity.sh config git --mode ssh --ssh-key ~/.ssh/id_ed25519 --remote origin")

    workspace_is_repo = (workspace / ".git").exists()
    if workspace_is_repo:
        remote_check = subprocess.run(["git", "-C", str(workspace), "remote", "get-url", remote], text=True, capture_output=True, check=False)
        if remote_check.returncode == 0:
            record("OK", f"Git remote is configured: {remote}")
        else:
            record("WARN", f"Git remote {remote} is not configured in {workspace}", f"git -C {workspace} remote add {remote} <repo-url>")
        identity = subprocess.run(["git", "-C", str(workspace), "config", "--get", "user.email"], text=True, capture_output=True, check=False)
        if identity.returncode == 0 and identity.stdout.strip():
            record("OK", "Git commit identity is configured")
        else:
            record("WARN", "Git commit identity is missing in workspace", f"git -C {workspace} config user.email you@example.com")
    else:
        record("WARN", f"MCP workspace is not a Git repo yet: {workspace}", "Run a WorkItem coding stage or prepare_work_branch first")

    if enabled and workspace_is_repo:
        head = subprocess.run(["git", "-C", str(workspace), "rev-parse", "--verify", "HEAD"], text=True, capture_output=True, check=False)
        if head.returncode != 0:
            record("WARN", "Git dry-run push skipped because the workspace has no commits yet", "Run a coding stage first")
            return
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        askpass_path = ""
        try:
            if mode == "token":
                token_env = merged.get("MCP_GIT_TOKEN_ENV") or "GITHUB_TOKEN"
                token = os.getenv(token_env) or merged.get("MCP_GIT_TOKEN") or ""
                if not token:
                    record("FAIL", f"Git dry-run push skipped because {token_env} is unavailable", f"export {token_env}=<github-token-with-repo-write>")
                    return
                fd, askpass_path = tempfile.mkstemp(prefix="singularity-git-askpass-", text=True)
                with os.fdopen(fd, "w") as fh:
                    fh.write("#!/usr/bin/env sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"${SINGULARITY_GIT_USERNAME:-x-access-token}\" ;;\n  *) printf '%s\\n' \"${SINGULARITY_GIT_TOKEN:-}\" ;;\nesac\n")
                os.chmod(askpass_path, 0o700)
                env["GIT_ASKPASS"] = askpass_path
                env["SINGULARITY_GIT_USERNAME"] = merged.get("MCP_GIT_USERNAME") or "x-access-token"
                env["SINGULARITY_GIT_TOKEN"] = token
            elif mode == "ssh":
                key_path = merged.get("MCP_GIT_SSH_KEY_HOST_PATH") or ""
                if key_path:
                    env["GIT_SSH_COMMAND"] = f"ssh -i {shlex.quote(str(Path(key_path).expanduser()))} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
            dry_run = subprocess.run(
                ["git", "-C", str(workspace), "push", "--dry-run", "-u", remote, "HEAD"],
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )
            if dry_run.returncode == 0:
                record("OK", "Git dry-run push succeeded")
            else:
                detail = (dry_run.stderr or dry_run.stdout or "").splitlines()
                reason = detail[0] if detail else "unknown git dry-run failure"
                reason = re.sub(r"https?://([^/\s:@]+):([^@\s/]+)@", "https://[REDACTED_CREDENTIALS]@", reason)
                record("FAIL", f"Git dry-run push failed: {reason}", "./singularity.sh doctor git")
        finally:
            if askpass_path:
                Path(askpass_path).unlink(missing_ok=True)


def run_command_isolation_doctor(record, merged: dict[str, str]) -> None:
    mode = (merged.get("MCP_COMMAND_EXECUTION_MODE") or "container").lower()
    if mode == "process":
        record("WARN", "MCP command execution is in process mode", "./singularity.sh config mcp --command-execution-mode container")
        return
    if mode != "container":
        record("FAIL", f"unknown MCP command execution mode: {mode}", "./singularity.sh config mcp --command-execution-mode container")
        return
    token = merged.get("MCP_RUNNER_TOKEN") or ""
    workspace = merged.get("MCP_RUNNER_HOST_WORKSPACE_PATH") or ""
    if len(token) < 16:
        record("FAIL", "MCP runner token must be at least 16 characters", "./singularity.sh config mcp --runner-token <token-at-least-16-chars>")
    elif not workspace:
        record("FAIL", "MCP runner host workspace path is missing", "./singularity.sh config mcp --sandbox-root <absolute-writable-path>")
    elif not Path(workspace).expanduser().is_absolute():
        record("FAIL", f"MCP runner host workspace path must be absolute: {workspace}", "./singularity.sh config mcp --runner-host-workspace-path <absolute-path>")
    else:
        record("OK", f"MCP command execution is container-isolated via {merged.get('MCP_RUNNER_URL') or 'runner'}")


def production_class_env(merged: dict[str, str]) -> str | None:
    for key in ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV"):
        value = (os.getenv(key) or merged.get(key) or "").strip().lower()
        if value in {"production", "prod", "staging", "perf"}:
            return f"{key}={value}"
    return None


def acceptable_isolation_evidence(raw: str) -> bool:
    evidence = raw.strip()
    if len(evidence) >= 12:
        return True
    return bool(re.fullmatch(r"[A-Z][A-Z0-9]+-\d{1,8}", evidence))


def weak_manifest_trusted_keys(raw: str) -> list[str]:
    value = raw.strip()
    if not value:
        return []
    try:
        if value.startswith("{"):
            parsed = json.loads(value)
            if not isinstance(parsed, dict):
                return ["<invalid-json>"]
            pairs = [(str(key), secret) for key, secret in parsed.items()]
        else:
            pairs = []
            for item in value.split(","):
                item = item.strip()
                if not item:
                    continue
                if ":" not in item:
                    pairs.append((item, ""))
                else:
                    key, secret = item.split(":", 1)
                    pairs.append((key.strip(), secret))
    except Exception:
        return ["<invalid-json>"]
    return [
        key or "<empty-key>"
        for key, secret in pairs
        if not isinstance(secret, str) or len(secret.strip()) < 32
    ]


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
        if not isinstance(secret, str) or len(secret.strip()) < 32 or weak_secret_value(secret):
            weak.append(source_name)
    return weak


def run_production_mode_doctor(record, merged: dict[str, str]) -> None:
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

    def live_value(key: str, default: str = "") -> str:
        return os.getenv(key) or merged.get(key) or default

    prod_signal = production_class_env(merged)
    if not prod_signal:
        record("OK", "production guard mode inactive (development/local)")
        return

    record("OK", f"production guard mode active via {prod_signal}")
    auth_optional = live_value("AUTH_OPTIONAL", "true").strip().lower()
    auth_provider = live_value("AUTH_PROVIDER", "iam").strip().lower()
    tenant_mode = live_value("TENANT_ISOLATION_MODE", "off").strip().lower()
    require_tenant_id = live_value("REQUIRE_TENANT_ID", "false").strip().lower()
    iam_service_token_tenant_ids = sorted({item.strip() for item in live_value("IAM_SERVICE_TOKEN_TENANT_IDS").split(",") if item.strip()})
    audit_token = live_value("AUDIT_GOV_SERVICE_TOKEN")
    learning_token = live_value("LEARNING_SERVICE_TOKEN", audit_token)
    workgraph_incoming_event_secrets = live_value("WORKGRAPH_INCOMING_EVENT_SECRETS")
    workgraph_event_secret_key = live_value("WORKGRAPH_EVENT_SECRET_KEY")
    workgraph_proxy_token = live_value("WORKGRAPH_PROXY_SERVICE_TOKEN")
    manifest_signature_mode = live_value("PROVIDER_MANIFEST_SIGNATURE_MODE", "auto").strip().lower()
    default_governance_mode = live_value("DEFAULT_GOVERNANCE_MODE", "fail_open").strip().lower()
    cf_tool_grant_enabled = live_value("CF_TOOL_GRANT_ENABLED", "false").strip().lower()
    mcp_default_governance_mode = live_value("MCP_DEFAULT_GOVERNANCE_MODE", "fail_open").strip().lower()
    mcp_tool_grant_mode = live_value("MCP_TOOL_GRANT_MODE", "off").strip().lower()
    mcp_require_effective_capabilities = live_value("MCP_REQUIRE_EFFECTIVE_CAPABILITIES", "false").strip().lower()
    tool_grant_signing_secret = live_value("TOOL_GRANT_SIGNING_SECRET")
    manifest_trusted_keys = live_value("PROVIDER_MANIFEST_TRUSTED_KEYS").strip()
    manifest_max_ttl_raw = live_value("PROVIDER_MANIFEST_MAX_TTL_SECONDS", "2592000").strip()
    agent_source_allow_private_urls = live_value("AGENT_SOURCE_ALLOW_PRIVATE_URLS", "false").strip().lower()
    try:
        manifest_max_ttl_seconds = int(manifest_max_ttl_raw)
    except ValueError:
        manifest_max_ttl_seconds = 0

    if auth_optional != "false":
        record("FAIL", "production-class deployment must set AUTH_OPTIONAL=false", "./singularity.sh config set platform.appEnv development  # or set AUTH_OPTIONAL=false and rotate secrets")
    else:
        record("OK", "AUTH_OPTIONAL=false")

    if auth_provider != "iam":
        record("FAIL", "production-class Workgraph must use AUTH_PROVIDER=iam", "set AUTH_PROVIDER=iam")
    else:
        record("OK", "AUTH_PROVIDER=iam")

    if tenant_mode != "strict":
        record("FAIL", "production-class Workgraph must set TENANT_ISOLATION_MODE=strict", "set TENANT_ISOLATION_MODE=strict")
    else:
        record("OK", "TENANT_ISOLATION_MODE=strict")

    if require_tenant_id != "true":
        record("FAIL", "production-class Context Fabric must set REQUIRE_TENANT_ID=true", "set REQUIRE_TENANT_ID=true")
    else:
        record("OK", "REQUIRE_TENANT_ID=true")

    if manifest_signature_mode != "required":
        record("FAIL", "production-class Agent Runtime must require signed provider manifests", "set PROVIDER_MANIFEST_SIGNATURE_MODE=required")
    else:
        record("OK", "PROVIDER_MANIFEST_SIGNATURE_MODE=required")

    if default_governance_mode != "fail_closed":
        record("FAIL", "production-class Context Fabric must default omitted governance to fail_closed", "set DEFAULT_GOVERNANCE_MODE=fail_closed")
    else:
        record("OK", "DEFAULT_GOVERNANCE_MODE=fail_closed")

    if cf_tool_grant_enabled not in {"1", "true", "yes", "on"}:
        record("FAIL", "production-class Context Fabric must mint MCP tool grants", "set CF_TOOL_GRANT_ENABLED=true")
    else:
        record("OK", "CF_TOOL_GRANT_ENABLED=true")

    if mcp_default_governance_mode != "fail_closed":
        record("FAIL", "production-class MCP must default omitted governance to fail_closed", "set MCP_DEFAULT_GOVERNANCE_MODE=fail_closed")
    else:
        record("OK", "MCP_DEFAULT_GOVERNANCE_MODE=fail_closed")

    if mcp_tool_grant_mode != "enforce":
        record("FAIL", "production-class MCP must enforce Context Fabric tool grants", "set MCP_TOOL_GRANT_MODE=enforce")
    else:
        record("OK", "MCP_TOOL_GRANT_MODE=enforce")

    if mcp_require_effective_capabilities not in {"1", "true", "yes", "on"}:
        record("FAIL", "production-class MCP must require effective agent capability snapshots", "set MCP_REQUIRE_EFFECTIVE_CAPABILITIES=true")
    else:
        record("OK", "MCP_REQUIRE_EFFECTIVE_CAPABILITIES=true")

    if len(tool_grant_signing_secret) < 32 or weak_secret_value(tool_grant_signing_secret):
        record("FAIL", "TOOL_GRANT_SIGNING_SECRET must be a rotated 32+ character non-default secret", "./singularity.sh config rotate-secrets")
    else:
        record("OK", "TOOL_GRANT_SIGNING_SECRET is rotated")

    if not manifest_trusted_keys:
        record("WARN", "no trusted provider manifest keys configured; external provider manifests will fail closed in production", "set PROVIDER_MANIFEST_TRUSTED_KEYS='{\"github\":\"<32+ char secret>\"}'")
    else:
        record("OK", "PROVIDER_MANIFEST_TRUSTED_KEYS configured")
        weak_keys = weak_manifest_trusted_keys(manifest_trusted_keys)
        if weak_keys:
            record(
                "FAIL",
                "PROVIDER_MANIFEST_TRUSTED_KEYS contains weak key secret(s): " + ", ".join(weak_keys),
                "set PROVIDER_MANIFEST_TRUSTED_KEYS='{\"github\":\"<32+ char secret>\"}'",
            )
        else:
            record("OK", "PROVIDER_MANIFEST_TRUSTED_KEYS secrets are strong")

    if manifest_max_ttl_seconds < 300:
        record("FAIL", "PROVIDER_MANIFEST_MAX_TTL_SECONDS must be at least 300", "set PROVIDER_MANIFEST_MAX_TTL_SECONDS=2592000")
    elif manifest_max_ttl_seconds > 90 * 24 * 60 * 60:
        record("WARN", "provider manifest TTL window is longer than 90 days", "consider PROVIDER_MANIFEST_MAX_TTL_SECONDS=2592000")
    else:
        record("OK", f"PROVIDER_MANIFEST_MAX_TTL_SECONDS={manifest_max_ttl_seconds}")

    if agent_source_allow_private_urls in {"1", "true", "yes", "on"}:
        record("FAIL", "production-class Agent Runtime must block private/local agent source URLs", "set AGENT_SOURCE_ALLOW_PRIVATE_URLS=false")
    else:
        record("OK", "AGENT_SOURCE_ALLOW_PRIVATE_URLS=false")

    weak_incoming_sources = weak_incoming_event_secrets(workgraph_incoming_event_secrets)
    if weak_incoming_sources:
        record(
            "FAIL",
            "WORKGRAPH_INCOMING_EVENT_SECRETS has missing or weak source secret(s): " + ", ".join(weak_incoming_sources),
            "set WORKGRAPH_INCOMING_EVENT_SECRETS to JSON like '{\"agent-runtime\":\"<32+ char secret>\"}'",
        )
    else:
        record("OK", "WORKGRAPH_INCOMING_EVENT_SECRETS configured")

    if len(workgraph_event_secret_key) < 32 or weak_secret_value(workgraph_event_secret_key):
        record("FAIL", "WORKGRAPH_EVENT_SECRET_KEY must be a rotated 32+ character secret", "./singularity.sh config rotate-secrets")
    else:
        record("OK", "WORKGRAPH_EVENT_SECRET_KEY is rotated")

    token_checks = [
        ("AUDIT_GOV_SERVICE_TOKEN", audit_token),
        ("LEARNING_SERVICE_TOKEN", learning_token),
    ]
    for name, value in token_checks:
        if len(value.strip()) < 32 or value.strip().startswith(("dev-", "test-", "change-me", "changeme")):
            record("FAIL", f"production-class platform-web proxy requires strong {name}", f"set {name.split('/')[0]} to a 32+ char service token")
        else:
            record("OK", f"{name} configured for platform-web proxy")

    workgraph_proxy_payload = jwt_payload(workgraph_proxy_token)
    if not workgraph_proxy_payload:
        record(
            "FAIL",
            "production-class platform-web proxy requires WORKGRAPH_PROXY_SERVICE_TOKEN to be a pre-minted IAM service JWT",
            "mint a platform-web service token via IAM /auth/service-token and set WORKGRAPH_PROXY_SERVICE_TOKEN to that JWT",
        )
    elif (
        workgraph_proxy_payload.get("kind") != "service"
        or workgraph_proxy_payload.get("service_name") != "platform-web"
        or workgraph_proxy_payload.get("sub") != "service:platform-web"
    ):
        record(
            "FAIL",
            "production-class platform-web proxy requires WORKGRAPH_PROXY_SERVICE_TOKEN minted for service_name=platform-web",
            "./singularity.sh config mint-workgraph-proxy-token",
        )
    else:
        scopes = {scope for scope in workgraph_proxy_payload.get("scopes", []) if isinstance(scope, str)}
        missing_scopes = sorted({"read:reference-data", "read:mcp-servers", "publish:events"} - scopes)
        token_tenant_ids = sorted({tenant_id.strip() for tenant_id in workgraph_proxy_payload.get("tenant_ids", []) if isinstance(tenant_id, str) and tenant_id.strip()})
        if missing_scopes:
            record(
                "FAIL",
                "WORKGRAPH_PROXY_SERVICE_TOKEN is missing required scope(s): " + ", ".join(missing_scopes),
                "./singularity.sh config mint-workgraph-proxy-token",
            )
        elif not token_tenant_ids:
            record(
                "FAIL",
                "production-class platform-web proxy requires WORKGRAPH_PROXY_SERVICE_TOKEN tenant_ids",
                "./singularity.sh config production-guardrails --tenant-id <tenant> && ./singularity.sh config mint-workgraph-proxy-token",
            )
        elif iam_service_token_tenant_ids and token_tenant_ids != iam_service_token_tenant_ids:
            record(
                "FAIL",
                "WORKGRAPH_PROXY_SERVICE_TOKEN tenant_ids must exactly match IAM_SERVICE_TOKEN_TENANT_IDS",
                "./singularity.sh config mint-workgraph-proxy-token",
            )
        else:
            record("OK", f"WORKGRAPH_PROXY_SERVICE_TOKEN configured as platform-web IAM service JWT ({len(token_tenant_ids)} tenant scope(s))")


def command_doctor(args: argparse.Namespace) -> None:
    failures = 0
    warnings = 0
    records: list[dict[str, str]] = []

    def record(status: str, message: str, fix: str = "") -> None:
        nonlocal failures, warnings
        if status == "FAIL":
            failures += 1
        elif status == "WARN":
            warnings += 1
        print(f"{status:<4} {message}")
        records.append({"status": status, "message": message, "fix": fix})

    print("Singularity configuration doctor\n")

    config = load_local_config()
    strict_office = bool(getattr(args, "office_copilot_only", False))
    copilot_fix_command = "./singularity.sh office-copilot-only"
    scope = getattr(args, "scope", "all")
    deep_smoke = os.getenv("SINGULARITY_DOCTOR_DEEP_SMOKE", "").strip().lower() in TRUE_ENV_VALUES

    def doctor_flag(name: str) -> bool:
        return deep_smoke or os.getenv(name, "").strip().lower() in TRUE_ENV_VALUES

    if scope == "secrets":
        run_secret_doctor(record)
        write_doctor_summary(records, failures=failures, warnings=warnings)
        if failures:
            sys.exit(1)
        return
    if scope == "git":
        run_git_doctor(record, merged_env_config())
        write_doctor_summary(records, failures=failures, warnings=warnings)
        if failures:
            sys.exit(1)
        return

    if CONFIG_PATH.exists():
        record("OK", f"canonical config exists: {CONFIG_PATH.relative_to(ROOT)}")
    else:
        record("WARN", f"canonical config missing: {CONFIG_PATH.relative_to(ROOT)}", "./singularity.sh config init --profile office-laptop")
    if strict_office:
        if config.get("profile") in COPILOT_ONLY_PROFILES:
            record("OK", f"canonical profile is {config.get('profile')}")
        else:
            expected = "office-copilot-only"
            record("FAIL", f"strict Copilot-only validation requires profile={expected}", copilot_fix_command)

    for path in [
        ROOT / ".env",
        ROOT / "singularity-iam-service/.env",
        ROOT / "context-fabric/.env",
        ROOT / "mcp-server/.env",
        ROOT / "agent-and-tools/.env",
        ROOT / "workgraph-studio/apps/api/.env",
    ]:
        if path.exists():
            record("OK", f"env file exists: {path.relative_to(ROOT)}")
        else:
            record("WARN", f"env file missing: {path.relative_to(ROOT)}", "./singularity.sh config write")

    checks = [
        ("agent-and-tools db", "localhost", 5432),
        ("iam db (consolidated)", "localhost", 5432),
        ("workgraph db", "localhost", 5434),
    ]
    for name, host, port in checks:
        if socket_open(host, port):
            record("OK", f"{name} tcp {host}:{port}")
        else:
            record("WARN", f"{name} tcp {host}:{port} closed", "./singularity.sh up")

    urls = [
        ("platform web", "http://localhost:5180", True),
        ("platform agents", "http://localhost:5180/agents/studio", True),
        ("platform workflows", "http://localhost:5180/workflows", True),
        ("platform workbench", "http://localhost:5180/workbench", True),
        ("platform foundry", "http://localhost:5180/foundry", True),
        ("platform identity", "http://localhost:5180/identity", True),
        ("iam", "http://localhost:8100/api/v1/health", True),
        ("context api", "http://localhost:8000/health", True),
        ("llm gateway", "http://localhost:8001/health", False),
        ("mcp server", "http://localhost:7100/health", False),
        ("agent service", "http://localhost:3001/health", True),
        ("tool service (agent-service)", "http://localhost:3001/health", True),
        ("agent runtime", "http://localhost:3003/health", True),
        ("prompt composer", "http://localhost:3004/health", True),
    ]
    for name, url, required in urls:
        status, msg = http_check(name, url, required=required)
        record(status, msg, f"./singularity.sh restart {service_name_for_url(name)}")

    nginx_guard = ROOT / "bin/check-nginx-docker-dns.sh"
    if nginx_guard.exists():
        guard = subprocess.run(
            ["bash", str(nginx_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "nginx Docker DNS guard passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"nginx Docker DNS guard failed: {first_line}", "bash bin/check-nginx-docker-dns.sh")

    run_frontend_token_doctor(record)
    run_handbook_html_doctor(record)

    context_profile_evidence_guard = ROOT / "bin/check-context-profile-evidence.py"
    if context_profile_evidence_guard.exists():
        guard = subprocess.run(
            ["python3", str(context_profile_evidence_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Context Fabric profile evidence contract passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Context Fabric profile evidence contract failed: {first_line}", "python3 bin/check-context-profile-evidence.py")

    bare_metal_topology_guard = ROOT / "bin/check-bare-metal-topology.sh"
    if bare_metal_topology_guard.exists():
        guard = subprocess.run(
            ["bash", str(bare_metal_topology_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "bare-metal topology guard passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"bare-metal topology guard failed: {first_line}", "bash bin/check-bare-metal-topology.sh")

    compose_profile_guard = ROOT / "bin/check-compose-profiles.sh"
    if compose_profile_guard.exists():
        guard = subprocess.run(
            ["bash", str(compose_profile_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "compose profile matrix passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"compose profile matrix failed: {first_line}", "bash bin/check-compose-profiles.sh")

    topology_contract_guard = ROOT / "bin/check-platform-topology-contract.py"
    if topology_contract_guard.exists():
        guard = subprocess.run(
            ["python3", str(topology_contract_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "platform topology contract passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform topology contract failed: {first_line}", "python3 bin/check-platform-topology-contract.py")

    platform_topology_guard = ROOT / "bin/check-platform-topology.py"
    if platform_topology_guard.exists():
        guard = subprocess.run(
            ["python3", str(platform_topology_guard), "--json"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            try:
                topology = json.loads(guard.stdout or "{}")
                running_count = topology.get("runningContainerCount", "?")
                record("OK", f"platform topology guard passed ({running_count} running containers)")
            except Exception:
                record("OK", "platform topology guard passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform topology guard failed: {first_line}", "python3 bin/check-platform-topology.py")

    agent_tools_topology_guard = ROOT / "bin/check-agent-tools-topology.sh"
    if agent_tools_topology_guard.exists():
        guard = subprocess.run(
            ["bash", str(agent_tools_topology_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "agent/tools topology guard passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"agent/tools topology guard failed: {first_line}", "bash bin/check-agent-tools-topology.sh")

    tenant_guard = ROOT / "bin/check-workgraph-tenant-guards.py"
    if tenant_guard.exists():
        guard = subprocess.run(
            ["python3", str(tenant_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Workgraph tenant guard coverage passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Workgraph tenant guard coverage failed: {first_line}", "python3 bin/check-workgraph-tenant-guards.py")

    tenant_db_guard = ROOT / "bin/check-workgraph-db-tenant-isolation.py"
    if tenant_db_guard.exists():
        guard_args = ["python3", str(tenant_db_guard)]
        prod_like = production_class_env(merged_env_config()) is not None
        if prod_like:
            guard_args.extend(["--require-db", "--strict-data"])
            rls_required_raw = os.getenv("WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED", "true").strip().lower()
            if rls_required_raw in {"0", "false", "no", "off"}:
                alternate_model = os.getenv("WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL", "").strip().lower()
                evidence = os.getenv("WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE", "").strip()
                allowed_models = {"schema-per-tenant", "database-per-tenant", "cluster-per-tenant"}
                if alternate_model not in allowed_models:
                    record(
                        "FAIL",
                        "production Workgraph forced-RLS check disabled without an approved alternate model",
                        "set WORKGRAPH_DB_TENANT_ISOLATION_ALTERNATE_MODEL=schema-per-tenant|database-per-tenant|cluster-per-tenant or remove WORKGRAPH_DB_TENANT_ISOLATION_REQUIRED=false",
                    )
                elif not acceptable_isolation_evidence(evidence):
                    record(
                        "FAIL",
                        "production Workgraph forced-RLS check disabled without evidence",
                        "set WORKGRAPH_DB_TENANT_ISOLATION_EVIDENCE to a ticket, runbook, or architecture reference",
                    )
                else:
                    record("WARN", f"production Workgraph forced-RLS check disabled for alternate isolation model: {alternate_model}", evidence)
            else:
                guard_args.append("--require-rls")
        guard = subprocess.run(
            guard_args,
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Workgraph tenant DB posture passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Workgraph tenant DB posture failed: {first_line}", "python3 bin/check-workgraph-db-tenant-isolation.py --require-db --strict-data")

    forced_rls_cutover_guard = ROOT / "bin/check-workgraph-forced-rls-cutover.py"
    if forced_rls_cutover_guard.exists():
        guard = subprocess.run(
            ["python3", str(forced_rls_cutover_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Workgraph forced-RLS cutover contract passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Workgraph forced-RLS cutover contract failed: {first_line}", "python3 bin/check-workgraph-forced-rls-cutover.py")

    # Grounding resilience (A1) — the LLM gateway only embeds for openai/openrouter/mock.
    # If the embedding alias resolves to a non-embedding provider (e.g. the default
    # anthropic), every embedding 400s and semantic grounding SILENTLY degrades to
    # recency/FTS. Surface it here (WARN by default; the guard --strict FAILs for prod).
    embedding_provider_guard = ROOT / "bin/check-embedding-provider.py"
    if embedding_provider_guard.exists():
        guard = subprocess.run(
            ["python3", str(embedding_provider_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        guard_output = (guard.stdout or guard.stderr or "").strip()
        first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else ""
        status = first_line.split(None, 1)[0] if first_line else ""
        detail = first_line.split(None, 1)[1] if " " in first_line else first_line
        if status == "OK":
            record("OK", "Embedding provider is embedding-capable (semantic grounding will work)")
        elif status == "WARN":
            record("WARN", f"Embedding provider: {detail}", "python3 bin/check-embedding-provider.py")
        else:
            record("FAIL", f"Embedding provider check failed: {detail or 'unknown'}", "python3 bin/check-embedding-provider.py --strict")

    forced_rls_enforcement_guard = ROOT / "bin/check-workgraph-forced-rls-enforcement.py"
    rls_enforcement_smoke = os.getenv("SINGULARITY_DOCTOR_RLS_ENFORCEMENT_SMOKE", "").strip().lower() in TRUE_ENV_VALUES
    if forced_rls_enforcement_guard.exists() and (deep_smoke or rls_enforcement_smoke):
        doctor_values = default_values(argparse.Namespace())
        admin_database_url = os.getenv("WORKGRAPH_DATABASE_URL_ADMIN") or doctor_values.get("WORKGRAPH_DATABASE_URL_ADMIN")
        guard_args = ["python3", str(forced_rls_enforcement_guard)]
        if admin_database_url:
            guard_args.extend(["--database-url", admin_database_url])
        guard = subprocess.run(
            guard_args,
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        guard_output = (guard.stdout or guard.stderr or "").strip()
        first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown result"
        if guard.returncode == 0:
            record("OK", f"Workgraph forced-RLS enforcement smoke passed ({first_line})")
        else:
            record("FAIL", f"Workgraph forced-RLS enforcement smoke failed: {first_line}", "python3 bin/check-workgraph-forced-rls-enforcement.py")

    m25_benchmark_guard = ROOT / "bin/check-m25-benchmarks.sh"
    if m25_benchmark_guard.exists():
        guard = subprocess.run(
            ["bash", str(m25_benchmark_guard)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "M25 retrieval benchmark contract passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"M25 retrieval benchmark contract failed: {first_line}", "bash bin/check-m25-benchmarks.sh")

    deploy_secret_manifest_guard = ROOT / "bin/check-github-environment-secrets.py"
    if deploy_secret_manifest_guard.exists():
        guard = subprocess.run(
            ["python3", str(deploy_secret_manifest_guard), "--skip-github"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "deploy required-secret manifest passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"deploy required-secret manifest failed: {first_line}", "python3 bin/check-github-environment-secrets.py")

    route_smoke = ROOT / "bin/check-platform-web-routes.py"
    if route_smoke.exists():
        guard = run_smoke_with_retry(["python3", str(route_smoke)])
        if guard.returncode == 0:
            record("OK", "platform web route/API smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform web route/API smoke failed: {first_line}", "python3 bin/check-platform-web-routes.py")

    api_parity_smoke = ROOT / "bin/check-platform-api-parity.py"
    if api_parity_smoke.exists():
        guard = run_smoke_with_retry(["python3", str(api_parity_smoke)])
        if guard.returncode == 0:
            record("OK", "platform API parity smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform API parity smoke failed: {first_line}", "python3 bin/check-platform-api-parity.py")

    parity_smoke = ROOT / "bin/check-platform-web-parity.py"
    if doctor_flag("SINGULARITY_DOCTOR_PARITY_SMOKE") and parity_smoke.exists():
        guard = subprocess.run(
            ["python3", str(parity_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "platform web July parity smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform web July parity smoke failed: {first_line}", "python3 bin/check-platform-web-parity.py")

    ui_smoke = ROOT / "bin/check-platform-web-ui.mjs"
    if doctor_flag("SINGULARITY_DOCTOR_UI_SMOKE") and ui_smoke.exists():
        guard = subprocess.run(
            ["node", str(ui_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "platform web browser smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"platform web browser smoke failed: {first_line}", "node bin/check-platform-web-ui.mjs")

    lifecycle_smoke = ROOT / "bin/check-workflow-lifecycle.py"
    if doctor_flag("SINGULARITY_DOCTOR_LIFECYCLE_SMOKE") and lifecycle_smoke.exists():
        guard = subprocess.run(
            ["python3", str(lifecycle_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "workflow lifecycle smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"workflow lifecycle smoke failed: {first_line}", "python3 bin/check-workflow-lifecycle.py")

    workbench_smoke = ROOT / "bin/check-workbench-lifecycle.py"
    if doctor_flag("SINGULARITY_DOCTOR_WORKBENCH_SMOKE") and workbench_smoke.exists():
        guard = subprocess.run(
            ["python3", str(workbench_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Workbench lifecycle smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Workbench lifecycle smoke failed: {first_line}", "python3 bin/check-workbench-lifecycle.py")

    foundry_smoke = ROOT / "bin/check-foundry-lifecycle.py"
    if doctor_flag("SINGULARITY_DOCTOR_FOUNDRY_SMOKE") and foundry_smoke.exists():
        guard = subprocess.run(
            ["python3", str(foundry_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "Foundry lifecycle smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"Foundry lifecycle smoke failed: {first_line}", "python3 bin/check-foundry-lifecycle.py")

    audit_smoke = ROOT / "bin/check-audit-governance-lifecycle.py"
    if os.getenv("SINGULARITY_DOCTOR_AUDIT_SMOKE", "").strip().lower() in {"1", "true", "yes"} and audit_smoke.exists():
        guard = subprocess.run(
            ["python3", str(audit_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "audit-governance lifecycle smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"audit-governance lifecycle smoke failed: {first_line}", "python3 bin/check-audit-governance-lifecycle.py")

    agent_profile_smoke = ROOT / "bin/check-agent-profile-lifecycle.py"
    if doctor_flag("SINGULARITY_DOCTOR_AGENT_PROFILE_SMOKE") and agent_profile_smoke.exists():
        guard = subprocess.run(
            ["python3", str(agent_profile_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "agent profile lifecycle smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"agent profile lifecycle smoke failed: {first_line}", "python3 bin/check-agent-profile-lifecycle.py")

    trace_spine_smoke = ROOT / "bin/test-trace-spine.sh"
    if os.getenv("SINGULARITY_DOCTOR_TRACE_SPINE", "").strip().lower() in TRUE_ENV_VALUES and trace_spine_smoke.exists():
        guard = subprocess.run(
            ["bash", str(trace_spine_smoke)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if guard.returncode == 0:
            record("OK", "trace spine smoke passed")
        else:
            guard_output = (guard.stderr or guard.stdout or "").strip()
            first_line = re.sub(r"\x1b\[[0-9;]*m", "", guard_output.splitlines()[0]) if guard_output else "unknown failure"
            record("FAIL", f"trace spine smoke failed: {first_line}", "bash bin/test-trace-spine.sh")

    merged = merged_env_config()
    run_production_mode_doctor(record, merged)
    run_git_doctor(record, merged)
    run_secret_doctor(record)
    provider = merged.get("MCP_LLM_PROVIDER") or merged.get("LLM_PROVIDER") or "mock"
    allowed_providers = [item.strip().lower() for item in (merged.get("MCP_ALLOWED_LLM_PROVIDERS") or "").split(",") if item.strip()]
    profile_copilot_only = config.get("profile") in COPILOT_ONLY_PROFILES
    copilot_only = strict_office or profile_copilot_only or allowed_providers == ["copilot"]
    if provider == "openai" and not (merged.get("OPENAI_API_KEY") or merged.get("OPENAI_COMPATIBLE_API_KEY")):
        record("FAIL", "OpenAI provider selected but no OpenAI key is configured", "./singularity.sh config set llm.openai.apiKey sk-...")
    elif provider == "openrouter" and not merged.get("OPENROUTER_API_KEY"):
        record("FAIL", "OpenRouter provider selected but no OpenRouter key is configured", "./singularity.sh config set llm.openrouter.apiKey sk-or-...")
    elif provider == "copilot" and not merged.get("COPILOT_TOKEN"):
        record("WARN", "Copilot provider selected but COPILOT_TOKEN is not configured; gh copilot CLI tools can still be used if installed", "./singularity.sh config set llm.copilot.token <token>")
    else:
        record("OK", f"LLM provider configuration: {provider}")
    if copilot_only:
        forbidden_config = [
            dotted
            for dotted in [
                "llm.openai.apiKey",
                "llm.openai.baseUrl",
                "llm.openrouter.apiKey",
                "llm.openrouter.baseUrl",
                "llm.anthropic.apiKey",
                "llm.ollama.baseUrl",
            ]
            if get_path(config, dotted)
        ]
        forbidden = [
            key
            for key in [
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
                "OPENAI_COMPATIBLE_API_KEY",
                "OPENAI_COMPATIBLE_BASE_URL",
                "OPENROUTER_API_KEY",
                "OPENROUTER_BASE_URL",
                "ANTHROPIC_API_KEY",
                "OLLAMA_BASE_URL",
            ]
            if merged.get(key)
        ]
        if provider != "copilot":
            record("FAIL", "Copilot-only mode requires MCP_LLM_PROVIDER/LLM_PROVIDER=copilot", copilot_fix_command)
        elif forbidden_config:
            record("FAIL", f"Copilot-only profile still contains non-Copilot config: {', '.join(forbidden_config)}", copilot_fix_command)
        elif forbidden:
            record("FAIL", f"Copilot-only mode has non-Copilot access still configured: {', '.join(forbidden)}", copilot_fix_command)
        else:
            record("OK", "Copilot-only provider fence is active")
        cli_ok, cli_msg = gh_copilot_ready()
        record("OK" if cli_ok else "WARN", cli_msg, "gh auth login && gh extension install github/gh-copilot")
        if strict_office:
            if allowed_providers == ["copilot"]:
                record("OK", "MCP provider allowlist is exactly copilot")
            else:
                record("FAIL", "strict Copilot-only validation requires MCP_ALLOWED_LLM_PROVIDERS=copilot", copilot_fix_command)

    mcp_token = merged.get("MCP_BEARER_TOKEN") or merged.get("MCP_DEMO_BEARER_TOKEN", "")
    if len(mcp_token) < 16:
        record("FAIL", "MCP bearer token must be at least 16 characters", "./singularity.sh config mcp --bearer-token <token-at-least-16-chars>")
    else:
        record("OK", "MCP bearer token length")
    run_command_isolation_doctor(record, merged)

    values = default_values(argparse.Namespace())
    for path, expected in target_envs(values).items():
        if not path.exists():
            continue
        current = parse_env(path)
        drifted = [
            key
            for key, value in expected.items()
            if key in current and current[key] != value and key not in LOCAL_OVERRIDE_DRIFT_KEYS
        ]
        local_overrides = [
            key
            for key, value in expected.items()
            if key in current and current[key] != value and key in LOCAL_OVERRIDE_DRIFT_KEYS
        ]
        if drifted:
            sample = ", ".join(drifted[:5])
            record("WARN", f"{path.relative_to(ROOT)} has config drift for {sample}", "./singularity.sh config write")
        elif local_overrides:
            record("OK", f"{path.relative_to(ROOT)} has {len(local_overrides)} local secret override(s)")

    model_catalog_path = merged.get("MCP_LLM_MODEL_CATALOG_PATH") or values.get("MCP_LLM_MODEL_CATALOG_PATH")
    if model_catalog_path:
        p = Path(model_catalog_path)
        if not p.is_absolute():
            p = ROOT / p
        if p.exists():
            record("OK", f"MCP model catalog exists: {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}")
            if copilot_only:
                try:
                    rows = json.loads(p.read_text())
                    providers = sorted({str(row.get("provider", "")).lower() for row in rows if isinstance(row, dict)})
                    if providers == ["copilot"]:
                        record("OK", "MCP model catalog is Copilot-only")
                    else:
                        record("FAIL", f"MCP model catalog includes non-Copilot providers: {', '.join(providers)}", copilot_fix_command)
                except Exception as exc:
                    record("WARN", f"Could not inspect MCP model catalog providers: {exc}", "./singularity.sh config mcp-catalog --copilot-only")
        else:
            fix = "./singularity.sh config mcp-catalog --copilot-only" if copilot_only else "./singularity.sh config mcp-catalog --default-alias mock"
            record("WARN", f"MCP model catalog missing: {p}", fix)

    provider_config_path = merged.get("MCP_LLM_PROVIDER_CONFIG_PATH") or values.get("MCP_LLM_PROVIDER_CONFIG_PATH")
    if provider_config_path:
        p = Path(provider_config_path)
        if not p.is_absolute():
            p = ROOT / p
        if p.exists():
            record("OK", f"MCP provider config exists: {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}")
            if copilot_only:
                try:
                    payload = json.loads(p.read_text())
                    allowed = [str(item).lower() for item in payload.get("allowedProviders", [])]
                    providers = payload.get("providers", {}) if isinstance(payload, dict) else {}
                    enabled_non_copilot = sorted(
                        name for name, body in providers.items()
                        if name != "copilot" and isinstance(body, dict) and body.get("enabled") is not False
                    )
                    if allowed == ["copilot"] and not enabled_non_copilot:
                        record("OK", "MCP provider config is Copilot-only")
                    else:
                        record("FAIL", "MCP provider config is not fenced to Copilot", copilot_fix_command)
                except Exception as exc:
                    record("WARN", f"Could not inspect MCP provider config: {exc}", copilot_fix_command)
        else:
            fix = "./singularity.sh config mcp-catalog --copilot-only" if copilot_only else "./singularity.sh config mcp-catalog --default-alias mock"
            record("WARN", f"MCP provider config missing: {p}", fix)

    if copilot_only:
        providers_status, providers_payload, providers_msg = http_json("http://localhost:7100/llm/providers", bearer_token=mcp_token)
        if providers_status != "OK":
            record("FAIL" if strict_office else "WARN", f"live MCP provider endpoint unavailable: {providers_msg}", "./singularity.sh restart mcp-server")
        else:
            data = providers_payload.get("data", providers_payload) if isinstance(providers_payload, dict) else {}
            default_provider = str(data.get("default_provider") or "").lower()
            live_providers = data.get("providers", []) if isinstance(data, dict) else []
            non_copilot_enabled = sorted(
                str(row.get("name", "")).lower()
                for row in live_providers
                if isinstance(row, dict)
                and str(row.get("name", "")).lower() != "copilot"
                and (row.get("allowed") is True or row.get("ready") is True)
            )
            copilot_row = next((row for row in live_providers if isinstance(row, dict) and str(row.get("name", "")).lower() == "copilot"), {})
            if default_provider == "copilot":
                record("OK", "live MCP default provider is copilot")
            else:
                record("FAIL", f"live MCP default provider is {default_provider or '(unset)'}, not copilot", f"{copilot_fix_command} && ./singularity.sh recreate mcp-server")
            if non_copilot_enabled:
                record("FAIL", f"live MCP still enables/allows non-Copilot providers: {', '.join(non_copilot_enabled)}", f"{copilot_fix_command} && ./singularity.sh recreate mcp-server")
            else:
                record("OK", "live MCP provider fence exposes only Copilot")
            if copilot_row.get("ready") is True:
                record("OK", "live MCP Copilot provider is ready")
            else:
                if not merged.get("COPILOT_TOKEN") and cli_ok:
                    record(
                        "WARN",
                        "live MCP Copilot gateway token is not configured; local gh copilot CLI/headless tools are available",
                        "./singularity.sh config set llm.copilot.token <token> && ./singularity.sh restart llm-gateway && ./singularity.sh recreate mcp-server",
                    )
                else:
                    status = "FAIL" if strict_office else "WARN"
                    record(status, "live MCP Copilot provider is not ready", "./singularity.sh config set llm.copilot.token <token> && ./singularity.sh restart llm-gateway && ./singularity.sh recreate mcp-server")

        models_status, models_payload, models_msg = http_json("http://localhost:7100/llm/models", bearer_token=mcp_token)
        if models_status != "OK":
            record("FAIL" if strict_office else "WARN", f"live MCP model endpoint unavailable: {models_msg}", "./singularity.sh restart mcp-server")
        else:
            data = models_payload.get("data", models_payload) if isinstance(models_payload, dict) else {}
            default_alias = str(data.get("defaultModelAlias") or "").lower()
            rows = data.get("models", []) if isinstance(data, dict) else []
            model_providers = sorted({str(row.get("provider", "")).lower() for row in rows if isinstance(row, dict)})
            if default_alias == "copilot":
                record("OK", "live MCP default model alias is copilot")
            else:
                record("FAIL", f"live MCP default model alias is {default_alias or '(unset)'}, not copilot", "./singularity.sh config mcp-catalog --copilot-only && ./singularity.sh recreate mcp-server")
            if model_providers == ["copilot"]:
                record("OK", "live MCP model catalog exposes only Copilot")
            else:
                record("FAIL", f"live MCP model catalog exposes non-Copilot providers: {', '.join(model_providers)}", "./singularity.sh config mcp-catalog --copilot-only && ./singularity.sh recreate mcp-server")

    write_doctor_summary(records, failures=failures, warnings=warnings)
    print(f"\nWrote doctor summaries: {DOCTOR_PATH.relative_to(ROOT)}, {PLATFORM_DOCTOR_PATH.relative_to(ROOT)}, {PORTAL_DOCTOR_PATH.relative_to(ROOT)}")

    if failures:
        print(f"\nDoctor finished with {failures} blocking issue(s).")
        sys.exit(1)
    print("\nDoctor finished. Warnings may be fine when services are intentionally stopped.")


def service_name_for_url(name: str) -> str:
    return {
        "platform web": "platform-web",
        "platform agents": "platform-web",
        "platform workflows": "platform-web",
        "platform workbench": "platform-web",
        "platform foundry": "platform-web",
        "platform identity": "platform-web",
        "iam": "iam-service",
        "context api": "context-api",
        "llm gateway": "llm-gateway",
        "context memory": "context-memory",
        "metrics ledger": "metrics-ledger",
        "mcp server": "mcp-server",
        "agent service": "platform-core",
        "tool service": "platform-core",
        "agent runtime": "platform-core",
        "prompt composer": "platform-core",
    }.get(name, name)


def command_export(args: argparse.Namespace) -> None:
    values = default_values(args)
    for key in sorted(values):
        print(f"export {key}={quote_env(values[key])}")


def command_mcp_register(args: argparse.Namespace) -> None:
    base = args.iam_base_url.rstrip("/")
    login_body = json.dumps({"email": args.email, "password": args.password}).encode()
    req = urllib.request.Request(
        f"{base}/auth/local/login",
        data=login_body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        token = json.loads(res.read().decode())["access_token"]

    payload = {
        "name": args.name,
        "description": args.description,
        "base_url": args.base_url,
        "auth_method": "BEARER_TOKEN",
        "bearer_token": args.bearer_token,
        "protocol": args.protocol,
        "protocol_version": "2024-11-05",
        "metadata": {"configured_by": "bin/configure-platform.py"},
        "tags": ["local", "configured"],
    }
    req = urllib.request.Request(
        f"{base}/capabilities/{args.capability_id}/mcp-servers",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            print(json.dumps(json.loads(res.read().decode()), indent=2))
    except urllib.error.HTTPError as exc:
        print(exc.read().decode(), file=sys.stderr)
        raise


def command_mcp_catalog(args: argparse.Namespace) -> None:
    """Create a static MCP model catalog and point local env files at it."""
    out = Path(args.path).expanduser()
    if not out.is_absolute():
        out = ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)

    default_alias = args.default_alias
    if args.copilot_only or str(default_alias or "").strip().lower() == "copilot":
        raise SystemExit(
            "Copilot model-provider catalogs are retired. Use the governed copilot_execute MCP tool "
            "with an AGENT_TASK executor=copilot."
        )
    if default_alias not in {"mock"}:
        raise SystemExit(
            "Generated model catalogs are restricted to mock. "
            "Copilot stages use executor=copilot through MCP; configure other approved providers explicitly."
        )
    catalog = [
        {
            "id": "mock",
            "label": "Mock offline",
            "provider": "mock",
            "model": "mock-fast",
            "default": True,
            "maxOutputTokens": 800,
            "supportsTools": False,
            "costTier": "mock",
            "description": "Offline deterministic model for smoke tests.",
        },
    ]
    if args.copilot_only:
        catalog = [
            {
                "id": "copilot",
                "label": "GitHub Copilot",
                "provider": "copilot",
                "model": args.copilot_model,
                "default": True,
                "maxOutputTokens": 2000,
                "supportsTools": True,
                "costTier": "medium",
                "description": "Office-safe model alias. MCP rejects all non-Copilot providers when MCP_ALLOWED_LLM_PROVIDERS=copilot.",
            },
        ]
    if not any(row["default"] for row in catalog):
        catalog[0]["default"] = True

    out.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")

    provider_config_path = ".singularity/llm-providers.json"
    provider_config = mcp_provider_config_payload(
        copilot_only=args.copilot_only,
        default_provider="copilot" if args.copilot_only else "mock",
        default_model=args.copilot_model if args.copilot_only else "mock-fast",
    )
    provider_config_out = write_mcp_provider_config(provider_config_path, provider_config)

    updates = {
        "MCP_LLM_MODEL_CATALOG_PATH": str(out),
        "MCP_LLM_MODEL_CATALOG_JSON": "",
        "MCP_LLM_PROVIDER_CONFIG_PATH": str(provider_config_out),
        "MCP_LLM_PROVIDER_CONFIG_JSON": "",
    }
    data = load_local_config()
    if data:
        set_path(data, "llm.providerConfigPath", str(provider_config_out))
        set_path(data, "llm.providerConfigJson", "")
        set_path(data, "llm.modelCatalogPath", str(out))
        set_path(data, "llm.modelCatalogJson", "")
        if args.copilot_only:
            set_path(data, "llm.provider", "copilot")
            set_path(data, "llm.model", args.copilot_model)
            set_path(data, "llm.allowedProviders", "copilot")
            set_path(data, "llm.providerConfigPath", str(provider_config_out))
            set_path(data, "llm.providerConfigJson", "")
            set_path(data, "llm.openai.apiKey", "")
            set_path(data, "llm.openai.baseUrl", "")
            set_path(data, "llm.openrouter.apiKey", "")
            set_path(data, "llm.openrouter.baseUrl", "")
            set_path(data, "llm.anthropic.apiKey", "")
            set_path(data, "llm.ollama.baseUrl", "")
            set_path(data, "llm.copilot.defaultModel", args.copilot_model)
        else:
            set_path(data, "llm.provider", "mock")
            set_path(data, "llm.model", "mock-fast")
            set_path(data, "llm.allowedProviders", "mock")
        write_local_config(data, force=True)
    if args.copilot_only:
        updates.update({
            "MCP_LLM_PROVIDER": "copilot",
            "LLM_PROVIDER": "copilot",
            "LLM_MODEL": args.copilot_model,
            "MCP_ALLOWED_LLM_PROVIDERS": "copilot",
            "MCP_LLM_PROVIDER_CONFIG_PATH": str(provider_config_out),
            "MCP_LLM_PROVIDER_CONFIG_JSON": "",
            "OPENAI_API_KEY": "",
            "OPENAI_COMPATIBLE_API_KEY": "",
            "OPENROUTER_API_KEY": "",
            "ANTHROPIC_API_KEY": "",
            "OLLAMA_BASE_URL": "",
            "COPILOT_DEFAULT_MODEL": args.copilot_model,
        })
    write_env(ROOT / ".env", updates, dry_run=False)
    write_env(ROOT / "mcp-server/.env", updates, dry_run=False)
    print("\nReload MCP after catalog changes:")
    print("  ./singularity.sh recreate mcp-server   # M101: reads its env_file — needs recreate, not restart")
    print("Then verify:")
    print("  curl -H \"Authorization: Bearer $MCP_BEARER_TOKEN\" http://localhost:7100/llm/models")


def command_models(_: argparse.Namespace) -> None:
    values = default_values(argparse.Namespace())
    catalog_path = values.get("MCP_LLM_MODEL_CATALOG_PATH") or ".singularity/llm-models.json"
    p = Path(catalog_path)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        print(f"No MCP model catalog found at {p}")
        print("Create one with:")
        print("  ./singularity.sh config mcp-catalog --default-alias mock")
        return
    rows = json.loads(p.read_text())
    print(f"MCP model catalog: {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}\n")
    for row in rows:
        provider = row.get("provider", "")
        ready = "yes"
        if provider == "openai" and not values.get("OPENAI_API_KEY"):
            ready = "missing OPENAI_API_KEY"
        elif provider == "openrouter" and not values.get("OPENROUTER_API_KEY"):
            ready = "missing OPENROUTER_API_KEY"
        elif provider == "anthropic" and not os.getenv("ANTHROPIC_API_KEY"):
            ready = "missing ANTHROPIC_API_KEY"
        elif provider == "copilot" and not values.get("COPILOT_TOKEN"):
            ready = "missing COPILOT_TOKEN (CLI tools may still work)"
        print(
            f"  {row.get('id'):<18} {row.get('provider'):<10} {row.get('model'):<28} "
            f"default={str(row.get('default', False)).lower():<5} ready={ready}"
        )


def provider_env_key(provider: str, body: dict | None = None) -> str:
    if isinstance(body, dict) and body.get("credentialEnv"):
        return str(body["credentialEnv"])
    return {
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "copilot": "COPILOT_TOKEN",
    }.get(provider, "")


def command_providers(_: argparse.Namespace) -> None:
    values = default_values(argparse.Namespace())
    provider_config_path = values.get("MCP_LLM_PROVIDER_CONFIG_PATH") or ".singularity/llm-providers.json"
    p = Path(provider_config_path)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        print(f"No MCP provider config found at {p}")
        print("Create one with:")
        print("  ./singularity.sh config mcp-catalog --default-alias mock")
        print("or:")
        print("  ./singularity.sh config office-copilot-only")
        return
    payload = json.loads(p.read_text())
    allowed = [str(item).lower() for item in payload.get("allowedProviders", [])]
    providers = payload.get("providers", {}) if isinstance(payload.get("providers"), dict) else {}
    print(f"MCP provider config: {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}")
    print(f"default: {payload.get('defaultProvider', values.get('LLM_PROVIDER'))} / {payload.get('defaultModel', values.get('LLM_MODEL'))}\n")
    for name in ["mock", "openai", "openrouter", "anthropic", "copilot"]:
        body = providers.get(name, {}) if isinstance(providers.get(name), dict) else {}
        enabled = body.get("enabled") is not False
        allowed_ok = not allowed or name in allowed
        env_key = provider_env_key(name, body)
        has_secret = True if name == "mock" else bool(values.get(env_key) or os.getenv(env_key, ""))
        ready = enabled and allowed_ok and has_secret
        reason = "ready" if ready else "disabled" if not enabled else "not allowed" if not allowed_ok else f"missing {env_key}"
        print(f"  {name:<10} {reason:<24} default={body.get('defaultModel', '-'):<24} credential={env_key or '-'}")


def add_common_write_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--llm-provider", choices=["mock", "openai", "openrouter", "ollama", "copilot"], default=None)
    parser.add_argument("--llm-model", default=None)
    parser.add_argument("--allowed-llm-providers", default=None, help="Comma-separated provider allowlist enforced by MCP, e.g. copilot")
    parser.add_argument("--openai-api-key", default=None)
    parser.add_argument("--openai-base-url", default=None)
    parser.add_argument("--openrouter-api-key", default=None)
    parser.add_argument("--anthropic-api-key", default=None)
    parser.add_argument("--copilot-token", default=None)
    parser.add_argument("--copilot-base-url", default=None)
    parser.add_argument("--mcp-bearer-token", default=None)
    parser.add_argument("--mcp-sandbox-root", default=None)
    parser.add_argument("--mcp-command-execution-mode", choices=["container", "process"], default=None)
    parser.add_argument("--mcp-runner-url", default=None)
    parser.add_argument("--mcp-runner-token", default=None)
    parser.add_argument("--mcp-runner-host-workspace-path", default=None)
    parser.add_argument("--mcp-runner-default-image", default=None)
    parser.add_argument("--mcp-runner-image-map-json", default=None)
    parser.add_argument("--mcp-runner-network-mode", default=None)
    parser.add_argument("--mcp-model-catalog-json", default=None)
    parser.add_argument("--mcp-model-catalog-path", default=None)
    parser.add_argument("--mcp-provider-config-json", default=None)
    parser.add_argument("--mcp-provider-config-path", default=None)
    parser.add_argument("--jwt-secret", default=None)
    parser.add_argument("--service-token", default=None)
    parser.add_argument("--audit-token", default=None)
    parser.add_argument("--pseudo-iam", action="store_true", help="Point local config at pseudo-IAM on :8101")
    parser.add_argument("--iam-base-url", default=None)
    parser.add_argument("--iam-service-url", default=None)
    parser.add_argument("--context-fabric-url", default=None)
    parser.add_argument("--blueprint-workbench-url", default=None)
    parser.add_argument("--prompt-composer-url", default=None)
    parser.add_argument("--agent-runtime-url", default=None)
    parser.add_argument("--tool-service-url", default=None)
    parser.add_argument("--agent-service-url", default=None)
    parser.add_argument("--mcp-server-url", default=None)
    parser.add_argument("--mcp-public-base-url", default=None)
    parser.add_argument("--iam-database-url", default=None)
    parser.add_argument("--agent-tools-database-url", default=None)
    parser.add_argument("--workgraph-database-url", default=None)


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure Singularity platform env files")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="Create .singularity/config.local.json and write env files")
    p_init.add_argument("--profile", choices=PROFILE_CHOICES, default="office-laptop")
    p_init.add_argument("--force", action="store_true", help="Overwrite existing local config profile")
    p_init.add_argument("--no-write", action="store_true", help="Only create the canonical config; do not write env files")
    add_common_write_args(p_init)
    p_init.set_defaults(func=command_init)

    p_write = sub.add_parser("write", help="Write the standard env files")
    add_common_write_args(p_write)
    p_write.add_argument("--dry-run", action="store_true")
    p_write.set_defaults(func=command_write)

    p_interactive = sub.add_parser("interactive", help="Prompt for common settings, then write env files")
    p_interactive.set_defaults(func=command_interactive)

    p_show = sub.add_parser("show", help="Show current relevant settings with secrets masked")
    p_show.set_defaults(func=command_show)

    p_doctor = sub.add_parser("doctor", help="Validate env files, ports, service URLs, and key presence")
    p_doctor.add_argument("scope", nargs="?", choices=["all", "git", "secrets"], default="all")
    p_doctor.add_argument("--office-copilot-only", action="store_true", help="Fail unless this laptop is fenced to Copilot-only provider/model access")
    p_doctor.set_defaults(func=command_doctor)

    p_set = sub.add_parser("set", help="Set one canonical config key and rewrite env files")
    p_set.add_argument("key", help="Dotted config key, e.g. llm.openai.apiKey")
    p_set.add_argument("value")
    p_set.add_argument("--no-write", action="store_true")
    p_set.set_defaults(func=command_set)

    p_rotate = sub.add_parser("rotate-secrets", help="Generate strong local JWT/service/runtime secrets and rewrite env files")
    p_rotate.add_argument("--include-bootstrap-password", action="store_true", help="Also rotate LOCAL_SUPER_ADMIN_PASSWORD; use only before first boot or after resetting the IAM user password")
    p_rotate.add_argument("--provider-manifest-key-id", default=None, help="Also create a trusted provider-manifest HMAC key with this key id and require signatures")
    p_rotate.add_argument("--no-write", action="store_true", help="Only update .singularity/config.local.json; do not rewrite env files")
    p_rotate.set_defaults(func=command_rotate_secrets)

    p_prod_guardrails = sub.add_parser("production-guardrails", help="Set canonical production safety guardrails and tenant-scoped service-token allowlists")
    p_prod_guardrails.add_argument("--tenant-id", action="append", required=True, help="Allowed tenant id. Repeat or pass comma-separated values.")
    p_prod_guardrails.add_argument("--env", default="production", help="Production-class environment label to write to APP_ENV/ENVIRONMENT/SINGULARITY_ENV")
    p_prod_guardrails.add_argument("--provider-manifest-signature-mode", choices=["required", "auto"], default="required")
    p_prod_guardrails.add_argument("--dry-run", action="store_true", help="Show updates without changing config or env files")
    p_prod_guardrails.add_argument("--no-write", action="store_true", help="Only update .singularity/config.local.json; do not rewrite env files")
    p_prod_guardrails.set_defaults(func=command_production_guardrails)

    p_prepare_prod = sub.add_parser("prepare-production", help="Prepare production guardrails/secrets, then rerun with --skip-rotate-secrets to mint the Workgraph proxy token and preflight")
    p_prepare_prod.add_argument("--tenant-id", action="append", required=True, help="Allowed tenant id. Repeat or pass comma-separated values.")
    p_prepare_prod.add_argument("--env", default="production", help="Production-class environment label to write to APP_ENV/ENVIRONMENT/SINGULARITY_ENV")
    p_prepare_prod.add_argument("--provider-manifest-key-id", default="platform-prod", help="Trusted provider-manifest key id to generate during secret rotation")
    p_prepare_prod.add_argument("--provider-manifest-signature-mode", choices=["required", "auto"], default="required")
    p_prepare_prod.add_argument("--include-bootstrap-password", action="store_true", help="Also rotate LOCAL_SUPER_ADMIN_PASSWORD; use only before first boot or with --admin-token")
    p_prepare_prod.add_argument("--ttl-hours", type=int, default=24 * 30, help="Workgraph proxy service-token TTL in hours, default 720.")
    p_prepare_prod.add_argument("--iam-base-url", default=None, help="IAM API base URL for service-token minting, default from canonical config.")
    p_prepare_prod.add_argument("--admin-token", default=None, help="Existing super-admin IAM JWT. Also read from IAM_ADMIN_TOKEN by the mint step.")
    p_prepare_prod.add_argument("--email", default=None, help="Bootstrap local admin email when --admin-token is not provided.")
    p_prepare_prod.add_argument("--password", default=None, help="Bootstrap local admin password when --admin-token is not provided.")
    p_prepare_prod.add_argument("--skip-rotate-secrets", action="store_true", help="Second-phase mode: reuse already-written guardrails/secrets and only mint/preflight against the current IAM")
    p_prepare_prod.add_argument("--skip-mint-workgraph-proxy-token", action="store_true", help="Do not mint WORKGRAPH_PROXY_SERVICE_TOKEN in this run")
    p_prepare_prod.add_argument("--skip-preflight", action="store_true", help="Do not run bin/check-deploy-env.sh --config-only after writing")
    p_prepare_prod.add_argument("--dry-run", action="store_true", help="Print the sequence without changing files")
    p_prepare_prod.add_argument("--no-write", action="store_true", help="Only update .singularity/config.local.json; do not rewrite env files")
    p_prepare_prod.set_defaults(func=command_prepare_production)

    p_mint_wg_proxy = sub.add_parser("mint-workgraph-proxy-token", help="Mint and write the IAM service JWT used by Platform Web to proxy Workgraph API calls")
    p_mint_wg_proxy.add_argument("--tenant-id", action="append", default=None, help="Allowed tenant id. Repeat or pass comma-separated values. Defaults to configured IAM_SERVICE_TOKEN_TENANT_IDS.")
    p_mint_wg_proxy.add_argument("--ttl-hours", type=int, default=24 * 30, help="Service-token TTL in hours, default 720.")
    p_mint_wg_proxy.add_argument("--iam-base-url", default=None, help="IAM API base URL, default from canonical config.")
    p_mint_wg_proxy.add_argument("--admin-token", default=None, help="Existing super-admin IAM JWT. Also read from IAM_ADMIN_TOKEN.")
    p_mint_wg_proxy.add_argument("--email", default=None, help="Bootstrap local admin email when --admin-token is not provided.")
    p_mint_wg_proxy.add_argument("--password", default=None, help="Bootstrap local admin password when --admin-token is not provided.")
    p_mint_wg_proxy.add_argument("--no-write", action="store_true", help="Only update .singularity/config.local.json; do not rewrite env files")
    p_mint_wg_proxy.set_defaults(func=command_mint_workgraph_proxy_token)

    p_reset_bootstrap = sub.add_parser("reset-bootstrap-password", help="Reset the existing IAM super-admin password hash to the canonical LOCAL_SUPER_ADMIN_PASSWORD")
    p_reset_bootstrap.set_defaults(func=command_reset_bootstrap_password)

    p_mcp_runtime = sub.add_parser("mcp", help="Configure the default/local MCP runtime")
    p_mcp_runtime.add_argument("--base-url", default=None)
    p_mcp_runtime.add_argument("--public-base-url", default=None)
    p_mcp_runtime.add_argument("--bearer-token", default=None)
    p_mcp_runtime.add_argument("--default-governance-mode", choices=["fail_open", "fail_closed", "degraded", "human_approval_required"], default=None)
    p_mcp_runtime.add_argument("--tool-grant-mode", choices=["off", "grace", "enforce"], default=None)
    p_mcp_runtime.add_argument("--require-effective-capabilities", action="store_true", default=None)
    p_mcp_runtime.add_argument("--tool-grant-signing-secret", default=None)
    p_mcp_runtime.add_argument("--sandbox-root", default=None)
    p_mcp_runtime.add_argument("--ast-db-path", default=None)
    p_mcp_runtime.add_argument("--command-execution-mode", choices=["container", "process"], default=None)
    p_mcp_runtime.add_argument("--runner-url", default=None)
    p_mcp_runtime.add_argument("--runner-token", default=None)
    p_mcp_runtime.add_argument("--runner-host-workspace-path", default=None)
    p_mcp_runtime.add_argument("--runner-default-image", default=None)
    p_mcp_runtime.add_argument("--runner-image-map-json", default=None)
    p_mcp_runtime.add_argument("--runner-network-mode", default=None)
    p_mcp_runtime.set_defaults(func=command_mcp)

    p_git = sub.add_parser("git", help="Configure local Git push credentials for approved WorkItem branches")
    p_git.add_argument("--mode", choices=["disabled", "ssh", "token"], required=True)
    p_git.add_argument("--ssh-key", default=None, help="Local SSH private key path. Stored as a path only; key contents are never copied into config.")
    p_git.add_argument("--token-env", default=None, help="Environment variable name holding the Git token. Token value is never stored in config.")
    p_git.add_argument("--remote", default=None, help="Git remote name to push to, default origin")
    p_git.add_argument("--branch-prefix", default=None, help="Default WorkItem branch prefix, default sg")
    p_git.add_argument("--no-write", action="store_true")
    p_git.set_defaults(func=command_git)

    p_export = sub.add_parser("export", help="Print shell exports for the standard profile")
    add_common_write_args(p_export)
    p_export.set_defaults(func=command_export)

    p_models = sub.add_parser("models", help="Show local MCP model catalog readiness")
    p_models.set_defaults(func=command_models)

    p_providers = sub.add_parser("providers", help="Show local MCP provider config readiness")
    p_providers.set_defaults(func=command_providers)

    p_office = sub.add_parser("office-copilot-only", help="Fence an office setup to GitHub Copilot only and blank other provider access")
    p_office.add_argument("--copilot-token", default=None, help="Optional Copilot API token; leave blank when using only gh copilot CLI tools")
    p_office.add_argument("--copilot-model", default="gpt-4o")
    p_office.set_defaults(func=command_office_copilot_only)

    bootstrap_identity = (load_local_config().get("identity", {}) if isinstance(load_local_config(), dict) else {})

    p_mcp = sub.add_parser("mcp-register", help="Register a local MCP server in IAM for a capability")
    p_mcp.add_argument("--capability-id", required=True)
    p_mcp.add_argument("--name", default="Local MCP Server")
    p_mcp.add_argument("--description", default="Configured by Singularity platform config utility")
    p_mcp.add_argument("--base-url", default="http://host.docker.internal:7100")
    p_mcp.add_argument("--bearer-token", default=os.getenv("MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars"))
    p_mcp.add_argument("--protocol", choices=["MCP_HTTP", "MCP_WS"], default="MCP_HTTP")
    p_mcp.add_argument("--iam-base-url", default="http://localhost:8100/api/v1")
    p_mcp.add_argument("--email", default=bootstrap_identity.get("bootstrapEmail", "admin@singularity.local"))
    p_mcp.add_argument("--password", default=bootstrap_identity.get("bootstrapPassword", "Admin1234!"))
    p_mcp.set_defaults(func=command_mcp_register)

    p_mcp_catalog = sub.add_parser("mcp-catalog", help="Create a local MCP model catalog file and wire env files to it")
    p_mcp_catalog.add_argument("--path", default=".singularity/llm-models.json")
    p_mcp_catalog.add_argument("--default-alias", choices=["mock", "copilot"], default="mock")
    p_mcp_catalog.add_argument("--copilot-only", action="store_true", help="Write a catalog containing only the GitHub Copilot alias")
    p_mcp_catalog.add_argument("--copilot-model", default="gpt-4o")
    p_mcp_catalog.set_defaults(func=command_mcp_catalog)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
