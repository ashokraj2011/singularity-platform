#!/usr/bin/env python3
"""Singularity platform configuration utility.

Centralizes the knobs that are otherwise scattered across docker compose
interpolation, Context Fabric, Workgraph, Agent-and-Tools, and the local MCP
server. The utility never deletes unknown env keys; it only updates the keys it
owns and appends missing keys with a marker block.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys
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
PORTAL_DOCTOR_PATH = ROOT / "singularity-portal/public/ops-doctor.json"


SECRET_HINTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASS", "DATABASE")


PROFILE_IAM_MODES = {
    "local-docker": "real-iam-dev",
    "office-laptop": "real-iam-dev",
    "office-copilot-only": "real-iam-dev",
    "pseudo-iam-dev": "pseudo-iam-dev",
    "real-iam-dev": "real-iam-dev",
}

PROFILE_CHOICES = list(PROFILE_IAM_MODES)


CONFIG_KEY_MAP = {
    "identity.jwtSecret": "JWT_SECRET",
    "identity.iamBaseUrl": "IAM_BASE_URL",
    "identity.iamServiceUrl": "IAM_SERVICE_URL",
    "identity.iamDatabaseUrl": "IAM_DATABASE_URL",
    "identity.bootstrapEmail": "LOCAL_SUPER_ADMIN_EMAIL",
    "identity.bootstrapPassword": "LOCAL_SUPER_ADMIN_PASSWORD",
    "services.agentToolsDatabaseUrl": "AGENT_TOOLS_DATABASE_URL",
    "services.workgraphDatabaseUrl": "WORKGRAPH_DATABASE_URL",
    "services.promptComposerUrl": "PROMPT_COMPOSER_URL",
    "services.agentRuntimeUrl": "AGENT_RUNTIME_URL",
    "services.toolServiceUrl": "TOOL_SERVICE_URL",
    "services.agentServiceUrl": "AGENT_SERVICE_URL",
    "services.contextFabricUrl": "CONTEXT_FABRIC_URL",
    "services.blueprintWorkbenchUrl": "BLUEPRINT_WORKBENCH_URL",
    "tokens.contextFabricServiceToken": "CONTEXT_FABRIC_SERVICE_TOKEN",
    "tokens.auditGovServiceToken": "AUDIT_GOV_SERVICE_TOKEN",
    "mcpRuntime.serverUrl": "MCP_SERVER_URL",
    "mcpRuntime.publicBaseUrl": "MCP_PUBLIC_BASE_URL",
    "mcpRuntime.bearerToken": "MCP_BEARER_TOKEN",
    "mcpRuntime.sandboxRoot": "MCP_SANDBOX_ROOT",
    "mcpRuntime.astDbPath": "MCP_AST_DB_PATH",
    "mcpRuntime.astMaxFileBytes": "MCP_AST_MAX_FILE_BYTES",
    "mcpRuntime.astMaxWorkspaceBytes": "MCP_AST_MAX_WORKSPACE_BYTES",
    "mcpRuntime.astMaxSymbols": "MCP_AST_MAX_SYMBOLS",
    "mcpRuntime.workBranchPrefix": "MCP_WORK_BRANCH_PREFIX",
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
}


def mask(key: str, value: str | None) -> str:
    if value is None:
        return ""
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
        out[env_key] = str(value)
    if get_path(data, "identity.mode") == "pseudo-iam-dev":
        out.setdefault("IAM_BASE_URL", "http://localhost:8101/api/v1")
        out.setdefault("IAM_SERVICE_URL", "http://localhost:8101")
    return out


def config_template(profile: str, args: argparse.Namespace | None = None) -> dict:
    mode = PROFILE_IAM_MODES.get(profile, "real-iam-dev")
    use_pseudo = mode == "pseudo-iam-dev"
    copilot_only = profile == "office-copilot-only" or bool(getattr(args, "office_copilot_only", False)) if args else profile == "office-copilot-only"
    sandbox_root = getattr(args, "mcp_sandbox_root", None) if args else None
    sandbox_root = sandbox_root or str(ROOT)
    provider = getattr(args, "llm_provider", None) if args else None
    provider = provider or ("copilot" if copilot_only else "mock")
    model = getattr(args, "llm_model", None) if args else None
    model = model or ("gpt-4o" if provider == "copilot" else "mock-fast")
    openai_key = getattr(args, "openai_api_key", None) if args else None
    openrouter_key = getattr(args, "openrouter_api_key", None) if args else None
    copilot_token = getattr(args, "copilot_token", None) if args else None
    mcp_token = getattr(args, "mcp_bearer_token", None) if args else None
    return {
        "profile": profile,
        "identity": {
            "mode": mode,
            "iamBaseUrl": "http://localhost:8101/api/v1" if use_pseudo else "http://localhost:8100/api/v1",
            "iamServiceUrl": "http://localhost:8101" if use_pseudo else "http://localhost:8100",
            "iamDatabaseUrl": "postgresql+asyncpg://singularity:singularity@localhost:5433/singularity_iam",
            "jwtSecret": os.getenv("JWT_SECRET", "dev-secret-change-in-prod-min-32-chars!!"),
            "bootstrapEmail": "admin@singularity.local",
            "bootstrapPassword": "Admin1234!",
        },
        "services": {
            "agentToolsDatabaseUrl": "postgresql://postgres:singularity@localhost:5432/singularity",
            "workgraphDatabaseUrl": "postgresql://workgraph:workgraph_secret@localhost:5434/workgraph",
            "promptComposerUrl": "http://localhost:3004",
            "agentRuntimeUrl": "http://localhost:3003",
            "toolServiceUrl": "http://localhost:3002",
            "agentServiceUrl": "http://localhost:3001",
            "contextFabricUrl": "http://localhost:8000",
            "blueprintWorkbenchUrl": "http://localhost:5176",
        },
        "tokens": {
            "contextFabricServiceToken": os.getenv("CONTEXT_FABRIC_SERVICE_TOKEN", "dev-context-fabric-service-token"),
            "auditGovServiceToken": os.getenv("AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token"),
        },
        "mcpRuntime": {
            "serverUrl": "http://localhost:7100",
            "publicBaseUrl": "http://host.docker.internal:7100",
            "bearerToken": mcp_token or os.getenv("MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars"),
            "sandboxRoot": sandbox_root,
            "astDbPath": f"{sandbox_root.rstrip('/')}/.singularity/mcp-ast.sqlite",
            "astMaxFileBytes": 200000,
            "astMaxWorkspaceBytes": 24000000,
            "astMaxSymbols": 250000,
            "workBranchPrefix": "sg",
        },
        "llm": {
            "provider": provider,
            "model": model,
            "allowedProviders": "copilot" if copilot_only else "",
            "providerConfigPath": ".singularity/llm-providers.json",
            "providerConfigJson": "",
            "modelCatalogPath": ".singularity/mcp-models.json",
            "modelCatalogJson": "",
            "openai": {
                "apiKey": "" if copilot_only else openai_key or os.getenv("OPENAI_API_KEY", ""),
                "baseUrl": "https://api.openai.com/v1",
            },
            "openrouter": {
                "apiKey": "" if copilot_only else openrouter_key or os.getenv("OPENROUTER_API_KEY", ""),
                "baseUrl": "https://openrouter.ai/api/v1",
            },
            "anthropic": {
                "apiKey": "",
            },
            "copilot": {
                "token": copilot_token or os.getenv("COPILOT_TOKEN", ""),
                "baseUrl": "https://api.githubcopilot.com",
                "defaultModel": model if provider == "copilot" else "gpt-4o",
            },
            "ollama": {
                "baseUrl": "" if copilot_only else "http://host.docker.internal:11434",
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
    llm_model = pick("LLM_MODEL", "llm_model", "LLM_MODEL", (
        "mock-fast" if llm_provider == "mock"
        else "gpt-4o" if llm_provider == "copilot"
        else "openai/gpt-4o-mini" if llm_provider == "openrouter"
        else "mock-fast"
    ))
    openai_key = pick("OPENAI_API_KEY", "openai_api_key", "OPENAI_API_KEY", "")
    openrouter_key = pick("OPENROUTER_API_KEY", "openrouter_api_key", "OPENROUTER_API_KEY", "")
    anthropic_key = pick("ANTHROPIC_API_KEY", "anthropic_api_key", "ANTHROPIC_API_KEY", "")
    copilot_token = pick("COPILOT_TOKEN", "copilot_token", "COPILOT_TOKEN", "")
    mcp_token = pick("MCP_BEARER_TOKEN", "mcp_bearer_token", "MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars")
    jwt_secret = pick("JWT_SECRET", "jwt_secret", "JWT_SECRET", "dev-secret-change-in-prod-min-32-chars!!")
    service_token = pick("CONTEXT_FABRIC_SERVICE_TOKEN", "service_token", "CONTEXT_FABRIC_SERVICE_TOKEN", "dev-context-fabric-service-token")
    audit_token = pick("AUDIT_GOV_SERVICE_TOKEN", "audit_token", "AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token")
    sandbox_root = pick("MCP_SANDBOX_ROOT", "mcp_sandbox_root", "MCP_SANDBOX_ROOT", str(ROOT))

    iam_base_default = "http://localhost:8101/api/v1" if use_pseudo else "http://localhost:8100/api/v1"
    iam_service_default = "http://localhost:8101" if use_pseudo else "http://localhost:8100"
    iam_base = pick("IAM_BASE_URL", "iam_base_url", "IAM_BASE_URL", iam_base_default)
    iam_service = pick("IAM_SERVICE_URL", "iam_service_url", "IAM_SERVICE_URL", iam_service_default)

    return {
        "JWT_SECRET": jwt_secret,
        "LOCAL_SUPER_ADMIN_EMAIL": pick("LOCAL_SUPER_ADMIN_EMAIL", None, "LOCAL_SUPER_ADMIN_EMAIL", "admin@singularity.local"),
        "LOCAL_SUPER_ADMIN_PASSWORD": pick("LOCAL_SUPER_ADMIN_PASSWORD", None, "LOCAL_SUPER_ADMIN_PASSWORD", "Admin1234!"),
        "AUTH_PROVIDER": "iam",
        "IAM_BASE_URL": iam_base,
        "IAM_SERVICE_URL": iam_service,
        "IAM_DATABASE_URL": pick("IAM_DATABASE_URL", "iam_database_url", "IAM_DATABASE_URL", "postgresql+asyncpg://singularity:singularity@localhost:5433/singularity_iam"),
        "AGENT_TOOLS_DATABASE_URL": pick("AGENT_TOOLS_DATABASE_URL", "agent_tools_database_url", "AGENT_TOOLS_DATABASE_URL", "postgresql://postgres:singularity@localhost:5432/singularity"),
        "WORKGRAPH_DATABASE_URL": pick("WORKGRAPH_DATABASE_URL", "workgraph_database_url", "WORKGRAPH_DATABASE_URL", "postgresql://workgraph:workgraph_secret@localhost:5434/workgraph"),
        "CONTEXT_FABRIC_SERVICE_TOKEN": service_token,
        "AUDIT_GOV_SERVICE_TOKEN": audit_token,
        "PROMPT_COMPOSER_URL": pick("PROMPT_COMPOSER_URL", "prompt_composer_url", "PROMPT_COMPOSER_URL", "http://localhost:3004"),
        "AGENT_RUNTIME_URL": pick("AGENT_RUNTIME_URL", "agent_runtime_url", "AGENT_RUNTIME_URL", "http://localhost:3003"),
        "TOOL_SERVICE_URL": pick("TOOL_SERVICE_URL", "tool_service_url", "TOOL_SERVICE_URL", "http://localhost:3002"),
        "AGENT_SERVICE_URL": pick("AGENT_SERVICE_URL", "agent_service_url", "AGENT_SERVICE_URL", "http://localhost:3001"),
        "CONTEXT_FABRIC_URL": pick("CONTEXT_FABRIC_URL", "context_fabric_url", "CONTEXT_FABRIC_URL", "http://localhost:8000"),
        "BLUEPRINT_WORKBENCH_URL": pick("BLUEPRINT_WORKBENCH_URL", "blueprint_workbench_url", "BLUEPRINT_WORKBENCH_URL", "http://localhost:5176"),
        "MCP_SERVER_URL": pick("MCP_SERVER_URL", "mcp_server_url", "MCP_SERVER_URL", "http://localhost:7100"),
        "MCP_PUBLIC_BASE_URL": pick("MCP_PUBLIC_BASE_URL", "mcp_public_base_url", "MCP_PUBLIC_BASE_URL", "http://host.docker.internal:7100"),
        "MCP_DEFAULT_BASE_URL": pick("MCP_SERVER_URL", "mcp_server_url", "MCP_DEFAULT_BASE_URL", "http://localhost:7100"),
        "MCP_DEFAULT_BEARER_TOKEN": mcp_token,
        "MCP_DEFAULT_SERVER_ID": "local-default-mcp",
        "MCP_BEARER_TOKEN": mcp_token,
        "MCP_DEMO_BEARER_TOKEN": mcp_token,
        "MCP_LLM_PROVIDER": llm_provider,
        "MCP_LLM_MODEL": llm_model,
        "MCP_ALLOWED_LLM_PROVIDERS": allowed_providers,
        "MCP_LLM_PROVIDER_CONFIG_JSON": pick("MCP_LLM_PROVIDER_CONFIG_JSON", "mcp_provider_config_json", "MCP_LLM_PROVIDER_CONFIG_JSON", ""),
        "MCP_LLM_PROVIDER_CONFIG_PATH": pick("MCP_LLM_PROVIDER_CONFIG_PATH", "mcp_provider_config_path", "MCP_LLM_PROVIDER_CONFIG_PATH", ".singularity/llm-providers.json"),
        "MCP_LLM_MODEL_CATALOG_JSON": pick("MCP_LLM_MODEL_CATALOG_JSON", "mcp_model_catalog_json", "MCP_LLM_MODEL_CATALOG_JSON", ""),
        "MCP_LLM_MODEL_CATALOG_PATH": pick("MCP_LLM_MODEL_CATALOG_PATH", "mcp_model_catalog_path", "MCP_LLM_MODEL_CATALOG_PATH", ""),
        "LLM_PROVIDER": llm_provider,
        "LLM_MODEL": llm_model,
        "OPENAI_API_KEY": "" if copilot_only else openai_key,
        "OPENAI_BASE_URL": pick("OPENAI_BASE_URL", "openai_base_url", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
        "OPENAI_DEFAULT_MODEL": llm_model if llm_provider == "openai" else "",
        "OPENAI_COMPATIBLE_API_KEY": "" if copilot_only else openai_key,
        "OPENAI_COMPATIBLE_BASE_URL": pick("OPENAI_BASE_URL", "openai_base_url", "OPENAI_COMPATIBLE_BASE_URL", "https://api.openai.com/v1"),
        "OPENROUTER_API_KEY": "" if copilot_only else openrouter_key,
        "OPENROUTER_BASE_URL": pick("OPENROUTER_BASE_URL", None, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        "OPENROUTER_APP_NAME": "Context Fabric",
        "OPENROUTER_SITE_URL": "http://localhost:8000",
        "ANTHROPIC_API_KEY": "" if copilot_only else anthropic_key,
        "WORKGRAPH_ANTHROPIC_API_KEY": "",
        "COPILOT_TOKEN": copilot_token,
        "COPILOT_BASE_URL": pick("COPILOT_BASE_URL", "copilot_base_url", "COPILOT_BASE_URL", "https://api.githubcopilot.com"),
        "COPILOT_DEFAULT_MODEL": pick("COPILOT_DEFAULT_MODEL", None, "COPILOT_DEFAULT_MODEL", llm_model if llm_provider == "copilot" else ""),
        "OLLAMA_BASE_URL": "" if copilot_only else pick("OLLAMA_BASE_URL", None, "OLLAMA_BASE_URL", "http://host.docker.internal:11434"),
        "SUMMARIZER_PROVIDER": "mock",
        "SUMMARIZER_MODEL": "mock-summarizer",
        "MCP_SANDBOX_ROOT": sandbox_root,
        "MCP_AST_DB_PATH": pick("MCP_AST_DB_PATH", None, "MCP_AST_DB_PATH", f"{sandbox_root.rstrip('/')}/.singularity/mcp-ast.sqlite"),
        "MCP_AST_MAX_FILE_BYTES": pick("MCP_AST_MAX_FILE_BYTES", None, "MCP_AST_MAX_FILE_BYTES", "200000"),
        "MCP_AST_MAX_WORKSPACE_BYTES": pick("MCP_AST_MAX_WORKSPACE_BYTES", None, "MCP_AST_MAX_WORKSPACE_BYTES", "24000000"),
        "MCP_AST_MAX_SYMBOLS": pick("MCP_AST_MAX_SYMBOLS", None, "MCP_AST_MAX_SYMBOLS", "250000"),
        "MCP_WORK_BRANCH_PREFIX": pick("MCP_WORK_BRANCH_PREFIX", None, "MCP_WORK_BRANCH_PREFIX", "sg"),
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
                "JWT_SECRET",
                "IAM_BASE_URL",
                "IAM_SERVICE_URL",
                "IAM_DATABASE_URL",
                "AGENT_TOOLS_DATABASE_URL",
                "WORKGRAPH_DATABASE_URL",
                "LOCAL_SUPER_ADMIN_EMAIL",
                "LOCAL_SUPER_ADMIN_PASSWORD",
                "CONTEXT_FABRIC_SERVICE_TOKEN",
                "AUDIT_GOV_SERVICE_TOKEN",
                "PROMPT_COMPOSER_URL",
                "AGENT_RUNTIME_URL",
                "TOOL_SERVICE_URL",
                "AGENT_SERVICE_URL",
                "CONTEXT_FABRIC_URL",
                "BLUEPRINT_WORKBENCH_URL",
                "MCP_SERVER_URL",
                "MCP_DEFAULT_BASE_URL",
                "MCP_DEFAULT_BEARER_TOKEN",
                "MCP_DEFAULT_SERVER_ID",
                "MCP_DEMO_BEARER_TOKEN",
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
            ]
        } | {
            # The root compose runs Context Fabric inside Docker, so the
            # default MCP route must use Docker DNS. Host-facing URLs remain
            # available as MCP_SERVER_URL and MCP_PUBLIC_BASE_URL.
            "MCP_DEFAULT_BASE_URL": "http://mcp-server-demo:7100",
        }),
        ROOT / "singularity-iam-service/.env": {
            "DATABASE_URL": values["IAM_DATABASE_URL"],
            "JWT_SECRET": values["JWT_SECRET"],
            "LOCAL_SUPER_ADMIN_EMAIL": values["LOCAL_SUPER_ADMIN_EMAIL"],
            "LOCAL_SUPER_ADMIN_PASSWORD": values["LOCAL_SUPER_ADMIN_PASSWORD"],
        },
        ROOT / "context-fabric/.env": {
            "LLM_GATEWAY_URL": "http://llm-gateway-service:8001",
            "CONTEXT_MEMORY_URL": "http://context-memory-service:8002",
            "METRICS_LEDGER_URL": "http://metrics-ledger-service:8003",
            "COMPOSER_URL": for_docker_host(values["PROMPT_COMPOSER_URL"]),
            "TOOL_SERVICE_URL": for_docker_host(values["TOOL_SERVICE_URL"]),
            "IAM_BASE_URL": for_docker_host(values["IAM_BASE_URL"]),
            "IAM_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
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
            "SUMMARIZER_PROVIDER": values["SUMMARIZER_PROVIDER"],
            "SUMMARIZER_MODEL": values["SUMMARIZER_MODEL"],
            "LLM_GATEWAY_INTERNAL_URL": "http://llm-gateway-service:8001",
        },
        ROOT / "mcp-server/.env": {
            "NODE_ENV": "development",
            "PORT": "7100",
            "MCP_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "LLM_PROVIDER": values["LLM_PROVIDER"],
            "LLM_MODEL": values["LLM_MODEL"],
            "MCP_ALLOWED_LLM_PROVIDERS": values["MCP_ALLOWED_LLM_PROVIDERS"],
            "MCP_LLM_PROVIDER_CONFIG_JSON": values["MCP_LLM_PROVIDER_CONFIG_JSON"],
            "MCP_LLM_PROVIDER_CONFIG_PATH": values["MCP_LLM_PROVIDER_CONFIG_PATH"],
            "MCP_LLM_MODEL_CATALOG_JSON": values["MCP_LLM_MODEL_CATALOG_JSON"],
            "MCP_LLM_MODEL_CATALOG_PATH": values["MCP_LLM_MODEL_CATALOG_PATH"],
            "OPENAI_API_KEY": values["OPENAI_API_KEY"],
            "OPENAI_BASE_URL": values["OPENAI_BASE_URL"],
            "OPENAI_DEFAULT_MODEL": values["OPENAI_DEFAULT_MODEL"],
            "OPENAI_COMPATIBLE_API_KEY": values["OPENAI_COMPATIBLE_API_KEY"],
            "OPENAI_COMPATIBLE_BASE_URL": values["OPENAI_COMPATIBLE_BASE_URL"],
            "OPENROUTER_API_KEY": values["OPENROUTER_API_KEY"],
            "OPENROUTER_BASE_URL": values["OPENROUTER_BASE_URL"],
            "ANTHROPIC_API_KEY": values["ANTHROPIC_API_KEY"],
            "COPILOT_TOKEN": values["COPILOT_TOKEN"],
            "COPILOT_BASE_URL": values["COPILOT_BASE_URL"],
            "COPILOT_DEFAULT_MODEL": values["COPILOT_DEFAULT_MODEL"],
            "MCP_SANDBOX_ROOT": values["MCP_SANDBOX_ROOT"],
            "MCP_AST_DB_PATH": values["MCP_AST_DB_PATH"],
            "MCP_AST_MAX_FILE_BYTES": values["MCP_AST_MAX_FILE_BYTES"],
            "MCP_AST_MAX_WORKSPACE_BYTES": values["MCP_AST_MAX_WORKSPACE_BYTES"],
            "MCP_AST_MAX_SYMBOLS": values["MCP_AST_MAX_SYMBOLS"],
            "MCP_WORK_BRANCH_PREFIX": values["MCP_WORK_BRANCH_PREFIX"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "CONTEXT_FABRIC_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
        },
        ROOT / "workgraph-studio/apps/api/.env": {
            "NODE_ENV": "development",
            "PORT": "8080",
            "DATABASE_URL": values["WORKGRAPH_DATABASE_URL"],
            "JWT_SECRET": values["JWT_SECRET"],
            "AUTH_PROVIDER": "iam",
            "IAM_BASE_URL": values["IAM_BASE_URL"],
            "PROMPT_COMPOSER_URL": values["PROMPT_COMPOSER_URL"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "CONTEXT_FABRIC_SERVICE_TOKEN": values["CONTEXT_FABRIC_SERVICE_TOKEN"],
            "MCP_SERVER_URL": values["MCP_SERVER_URL"],
            "TOOL_SERVICE_URL": values["TOOL_SERVICE_URL"],
            "AGENT_RUNTIME_URL": values["AGENT_RUNTIME_URL"],
            "MINIO_ENDPOINT": "localhost",
            "MINIO_PORT": "9000",
            "MINIO_USE_SSL": "false",
            "MINIO_ACCESS_KEY": "workgraph",
            "MINIO_SECRET_KEY": "workgraph_secret",
            "MINIO_BUCKET": "workgraph-documents",
        },
        ROOT / "workgraph-studio/apps/web/.env.local": {
            "VITE_AUTH_PROVIDER": "iam",
            "VITE_IAM_LOGIN_URL": "http://localhost:5175/login",
            "VITE_IAM_BASE_URL": values["IAM_BASE_URL"],
            "VITE_PSEUDO_IAM_URL": "http://localhost:8101/api/v1",
            "VITE_BLUEPRINT_WORKBENCH_URL": values["BLUEPRINT_WORKBENCH_URL"],
            "VITE_AUTO_LOGIN": "0",
        },
        ROOT / "agent-and-tools/.env": {
            "DATABASE_URL": values["AGENT_TOOLS_DATABASE_URL"],
            "JWT_SECRET": values["JWT_SECRET"],
            "IAM_SERVICE_URL": values["IAM_SERVICE_URL"],
            "IAM_BASE_URL": values["IAM_BASE_URL"],
            "CONTEXT_FABRIC_URL": values["CONTEXT_FABRIC_URL"],
            "MCP_SERVER_URL": values["MCP_SERVER_URL"],
            "MCP_BEARER_TOKEN": values["MCP_BEARER_TOKEN"],
            "NEXT_PUBLIC_AGENT_SERVICE_URL": values["AGENT_SERVICE_URL"],
            "NEXT_PUBLIC_TOOL_SERVICE_URL": values["TOOL_SERVICE_URL"],
            "NEXT_PUBLIC_AGENT_RUNTIME_URL": values["AGENT_RUNTIME_URL"],
            "NEXT_PUBLIC_PROMPT_COMPOSER_URL": values["PROMPT_COMPOSER_URL"],
        },
        ROOT / "singularity-portal/.env.local": {
            "VITE_IAM_BASE_URL": values["IAM_BASE_URL"],
            "VITE_WORKGRAPH_BASE_URL": "http://localhost:8080/api",
            "VITE_COMPOSER_BASE_URL": "http://localhost:3004/api/v1",
            "VITE_CONTEXT_FABRIC_BASE_URL": values["CONTEXT_FABRIC_URL"],
            "VITE_MCP_BASE_URL": values["MCP_SERVER_URL"],
            "VITE_LINK_AGENT_ADMIN": "http://localhost:3000",
            "VITE_LINK_IAM_ADMIN": "http://localhost:5175",
            "VITE_LINK_WORKGRAPH_DESIGNER": "http://localhost:5174",
            "VITE_LINK_BLUEPRINT_WORKBENCH": values["BLUEPRINT_WORKBENCH_URL"],
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
    print("\nDone. Restart affected containers after env changes:")
    print("  ./singularity.sh restart context-api")
    print("  ./singularity.sh restart llm-gateway")
    print("  ./singularity.sh restart mcp-server-demo")
    print("  ./singularity.sh restart workgraph-api")
    print("  ./singularity.sh restart workgraph-web")
    print("  ./singularity.sh restart blueprint-workbench")


def command_init(args: argparse.Namespace) -> None:
    data = config_template(args.profile, args)
    write_local_config(data, force=args.force)
    if args.no_write:
        print("\nConfig profile created. Write env files when ready:")
        print("  ./singularity.sh config export")
        print("  ./singularity.sh config write")
        return
    command_write(args)
    if args.profile == "office-copilot-only":
        args.path = ".singularity/mcp-models.json"
        args.default_alias = "copilot"
        args.copilot_only = True
        args.copilot_model = getattr(args, "llm_model", None) or "gpt-4o"
        args.openai_fast_model = "gpt-4o-mini"
        args.openai_balanced_model = "gpt-4o"
        args.openrouter_model = "openai/gpt-4o-mini"
        args.anthropic_model = "claude-sonnet-4-6"
        command_mcp_catalog(args)
    print("\nNext:")
    if args.profile == "office-copilot-only":
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


def command_mcp(args: argparse.Namespace) -> None:
    data = load_local_config() or config_template("office-laptop", args)
    if args.base_url:
        set_path(data, "mcpRuntime.serverUrl", args.base_url)
    if args.public_base_url:
        set_path(data, "mcpRuntime.publicBaseUrl", args.public_base_url)
    if args.bearer_token:
        set_path(data, "mcpRuntime.bearerToken", args.bearer_token)
    if args.sandbox_root:
        root = str(Path(args.sandbox_root).expanduser())
        set_path(data, "mcpRuntime.sandboxRoot", root)
        if not args.ast_db_path:
            set_path(data, "mcpRuntime.astDbPath", f"{root.rstrip('/')}/.singularity/mcp-ast.sqlite")
    if args.ast_db_path:
        set_path(data, "mcpRuntime.astDbPath", str(Path(args.ast_db_path).expanduser()))
    write_local_config(data, force=True)
    command_write(args)


def mcp_provider_config_payload(*, copilot_only: bool, default_provider: str, default_model: str) -> dict:
    providers = {
        "mock": {
            "enabled": not copilot_only,
            "defaultModel": "mock-fast",
            "supportsTools": False,
            "costTier": "mock",
            "description": "Offline deterministic model for smoke tests.",
        },
        "openai": {
            "enabled": not copilot_only,
            "baseUrl": "https://api.openai.com/v1",
            "defaultModel": "gpt-4o-mini" if default_provider != "openai" else default_model,
            "credentialEnv": "OPENAI_API_KEY",
            "supportsTools": True,
            "costTier": "medium",
        },
        "openrouter": {
            "enabled": not copilot_only,
            "baseUrl": "https://openrouter.ai/api/v1",
            "defaultModel": "openai/gpt-4o-mini" if default_provider != "openrouter" else default_model,
            "credentialEnv": "OPENROUTER_API_KEY",
            "supportsTools": True,
            "costTier": "medium",
        },
        "anthropic": {
            "enabled": not copilot_only,
            "baseUrl": "https://api.anthropic.com",
            "defaultModel": "claude-sonnet-4-6" if default_provider != "anthropic" else default_model,
            "credentialEnv": "ANTHROPIC_API_KEY",
            "supportsTools": True,
            "costTier": "high",
        },
        "copilot": {
            "enabled": True,
            "baseUrl": "https://api.githubcopilot.com",
            "defaultModel": default_model if default_provider == "copilot" or copilot_only else "gpt-4o",
            "credentialEnv": "COPILOT_TOKEN",
            "supportsTools": True,
            "costTier": "medium",
            "description": "GitHub Copilot provider owned by the local MCP runtime.",
        },
    }
    return {
        "defaultProvider": "copilot" if copilot_only else default_provider,
        "defaultModel": default_model,
        "allowedProviders": ["copilot"] if copilot_only else [],
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


def apply_copilot_only(data: dict, *, token: str | None = None, model: str = "gpt-4o") -> dict:
    data["profile"] = "office-copilot-only"
    set_path(data, "llm.provider", "copilot")
    set_path(data, "llm.model", model)
    set_path(data, "llm.allowedProviders", "copilot")
    set_path(data, "llm.providerConfigPath", ".singularity/llm-providers.json")
    set_path(data, "llm.providerConfigJson", "")
    set_path(data, "llm.modelCatalogPath", ".singularity/mcp-models.json")
    set_path(data, "llm.modelCatalogJson", "")
    set_path(data, "llm.openai.apiKey", "")
    set_path(data, "llm.openrouter.apiKey", "")
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
    """Fence office setups to GitHub Copilot only and clear other provider access."""
    data = load_local_config() or config_template("office-copilot-only", args)
    apply_copilot_only(data, token=args.copilot_token, model=args.copilot_model)
    write_local_config(data, force=True)
    args.llm_provider = "copilot"
    args.llm_model = args.copilot_model
    args.allowed_llm_providers = "copilot"
    args.openai_api_key = ""
    args.openrouter_api_key = ""
    args.anthropic_api_key = ""
    args.copilot_base_url = "https://api.githubcopilot.com"
    command_write(args)
    args.path = ".singularity/mcp-models.json"
    args.default_alias = "copilot"
    args.copilot_only = True
    args.openai_fast_model = "gpt-4o-mini"
    args.openai_balanced_model = "gpt-4o"
    args.openrouter_model = "openai/gpt-4o-mini"
    args.anthropic_model = "claude-sonnet-4-6"
    command_mcp_catalog(args)
    print("\nOffice Copilot-only mode is active.")
    print("Non-Copilot provider keys are blanked in generated env files and MCP enforces:")
    print("  .singularity/llm-providers.json")
    print("  .singularity/mcp-models.json")
    print("  MCP_ALLOWED_LLM_PROVIDERS=copilot")
    print("\nIf you only use the GitHub Copilot CLI tools, make sure this passes:")
    print("  cd mcp-server && npm run build && npx singularity-mcp doctor")


def command_interactive(args: argparse.Namespace) -> None:
    print("Singularity configuration wizard\n")
    provider = prompt_choice("LLM provider", ["copilot", "openai", "openrouter", "ollama", "mock"], "copilot")
    args.llm_provider = provider
    args.llm_model = input_default("LLM model", "mock-fast" if provider == "mock" else "gpt-4o" if provider == "copilot" else "gpt-4o-mini")
    if provider == "openai":
        args.openai_api_key = getpass.getpass("OpenAI API key (blank to preserve/env): ").strip() or None
    elif provider == "openrouter":
        args.openrouter_api_key = getpass.getpass("OpenRouter API key (blank to preserve/env): ").strip() or None
    elif provider == "copilot":
        args.copilot_token = getpass.getpass("Copilot token (blank if using CLI tools only): ").strip() or None
        args.allowed_llm_providers = input_default("Restrict MCP to Copilot only? [Y/n]", "Y").lower() != "n" and "copilot" or ""
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
        "MCP_AST_DB_PATH",
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


def http_check(name: str, url: str, timeout: float = 2.0) -> tuple[str, str]:
    try:
        req = urllib.request.Request(url, headers={"user-agent": "singularity-config-doctor"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return "OK", f"{name} {res.status}"
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            return "OK", f"{name} reachable ({exc.code})"
        return "WARN", f"{name} HTTP {exc.code}"
    except Exception as exc:
        return "FAIL", f"{name} unreachable: {exc}"


def http_json(url: str, timeout: float = 2.0) -> tuple[str, dict | None, str]:
    try:
        req = urllib.request.Request(url, headers={"user-agent": "singularity-config-doctor"})
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
    PORTAL_DOCTOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    PORTAL_DOCTOR_PATH.write_text(json.dumps(payload, indent=2) + "\n")


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

    if CONFIG_PATH.exists():
        record("OK", f"canonical config exists: {CONFIG_PATH.relative_to(ROOT)}")
    else:
        record("WARN", f"canonical config missing: {CONFIG_PATH.relative_to(ROOT)}", "./singularity.sh config init --profile office-laptop")
    if strict_office:
        if config.get("profile") == "office-copilot-only":
            record("OK", "canonical profile is office-copilot-only")
        else:
            record("FAIL", "strict office validation requires profile=office-copilot-only", "./singularity.sh office-copilot-only")

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
        ("iam db", "localhost", 5433),
        ("workgraph db", "localhost", 5434),
    ]
    for name, host, port in checks:
        if socket_open(host, port):
            record("OK", f"{name} tcp {host}:{port}")
        else:
            record("WARN", f"{name} tcp {host}:{port} closed", "./singularity.sh up")

    urls = [
        ("portal", "http://localhost:5180"),
        ("workgraph web", "http://localhost:5174"),
        ("blueprint workbench", "http://localhost:5176"),
        ("agent web", "http://localhost:3000"),
        ("iam", "http://localhost:8100/api/v1/health"),
        ("context api", "http://localhost:8000/health"),
        ("llm gateway", "http://localhost:8001/health"),
        ("context memory", "http://localhost:8002/health"),
        ("metrics ledger", "http://localhost:8003/health"),
        ("mcp server", "http://localhost:7100/health"),
        ("agent runtime", "http://localhost:3003/health"),
        ("prompt composer", "http://localhost:3004/health"),
    ]
    for name, url in urls:
        status, msg = http_check(name, url)
        record(status, msg, f"./singularity.sh restart {service_name_for_url(name)}")

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
    provider = merged.get("MCP_LLM_PROVIDER") or merged.get("LLM_PROVIDER") or "mock"
    allowed_providers = [item.strip().lower() for item in (merged.get("MCP_ALLOWED_LLM_PROVIDERS") or "").split(",") if item.strip()]
    profile_copilot_only = config.get("profile") == "office-copilot-only"
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
        forbidden = [
            key for key in ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL"]
            if merged.get(key)
        ]
        if provider != "copilot":
            record("FAIL", "Copilot-only mode requires MCP_LLM_PROVIDER/LLM_PROVIDER=copilot", "./singularity.sh config office-copilot-only")
        elif forbidden:
            record("FAIL", f"Copilot-only mode has non-Copilot access still configured: {', '.join(forbidden)}", "./singularity.sh config office-copilot-only")
        else:
            record("OK", "Copilot-only provider fence is active")
        cli_ok, cli_msg = gh_copilot_ready()
        record("OK" if cli_ok else "WARN", cli_msg, "gh auth login && gh extension install github/gh-copilot")
        if strict_office:
            if allowed_providers == ["copilot"]:
                record("OK", "MCP provider allowlist is exactly copilot")
            else:
                record("FAIL", "strict office validation requires MCP_ALLOWED_LLM_PROVIDERS=copilot", "./singularity.sh office-copilot-only")

    mcp_token = merged.get("MCP_DEMO_BEARER_TOKEN") or merged.get("MCP_BEARER_TOKEN", "")
    if len(mcp_token) < 16:
        record("FAIL", "MCP bearer token must be at least 16 characters", "./singularity.sh config mcp --bearer-token <token-at-least-16-chars>")
    else:
        record("OK", "MCP bearer token length")

    values = default_values(argparse.Namespace())
    for path, expected in target_envs(values).items():
        if not path.exists():
            continue
        current = parse_env(path)
        drifted = [key for key, value in expected.items() if key in current and current[key] != value]
        if drifted:
            sample = ", ".join(drifted[:5])
            record("WARN", f"{path.relative_to(ROOT)} has config drift for {sample}", "./singularity.sh config write")

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
                        record("FAIL", f"MCP model catalog includes non-Copilot providers: {', '.join(providers)}", "./singularity.sh config office-copilot-only")
                except Exception as exc:
                    record("WARN", f"Could not inspect MCP model catalog providers: {exc}", "./singularity.sh config mcp-catalog --copilot-only")
        else:
            fix = "./singularity.sh config mcp-catalog --copilot-only" if copilot_only else "./singularity.sh config mcp-catalog --default-alias balanced"
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
                        record("FAIL", "MCP provider config is not fenced to Copilot", "./singularity.sh config office-copilot-only")
                except Exception as exc:
                    record("WARN", f"Could not inspect MCP provider config: {exc}", "./singularity.sh config office-copilot-only")
        else:
            fix = "./singularity.sh config mcp-catalog --copilot-only" if copilot_only else "./singularity.sh config mcp-catalog --default-alias balanced"
            record("WARN", f"MCP provider config missing: {p}", fix)

    if copilot_only:
        providers_status, providers_payload, providers_msg = http_json("http://localhost:7100/llm/providers")
        if providers_status != "OK":
            record("FAIL" if strict_office else "WARN", f"live MCP provider endpoint unavailable: {providers_msg}", "./singularity.sh restart mcp-server-demo")
        else:
            data = providers_payload.get("data", providers_payload) if isinstance(providers_payload, dict) else {}
            default_provider = str(data.get("default_provider") or "").lower()
            live_providers = data.get("providers", []) if isinstance(data, dict) else []
            non_copilot_enabled = sorted(
                str(row.get("name", "")).lower()
                for row in live_providers
                if isinstance(row, dict)
                and str(row.get("name", "")).lower() != "copilot"
                and (row.get("enabled") is True or row.get("allowed") is True)
            )
            copilot_row = next((row for row in live_providers if isinstance(row, dict) and str(row.get("name", "")).lower() == "copilot"), {})
            if default_provider == "copilot":
                record("OK", "live MCP default provider is copilot")
            else:
                record("FAIL", f"live MCP default provider is {default_provider or '(unset)'}, not copilot", "./singularity.sh office-copilot-only && ./singularity.sh restart mcp-server-demo")
            if non_copilot_enabled:
                record("FAIL", f"live MCP still enables/allows non-Copilot providers: {', '.join(non_copilot_enabled)}", "./singularity.sh office-copilot-only && ./singularity.sh restart mcp-server-demo")
            else:
                record("OK", "live MCP provider fence exposes only Copilot")
            if copilot_row.get("ready") is True:
                record("OK", "live MCP Copilot provider is ready")
            else:
                status = "FAIL" if strict_office else "WARN"
                record(status, "live MCP Copilot provider is not ready", "./singularity.sh config set llm.copilot.token <token> && ./singularity.sh restart mcp-server-demo")

        models_status, models_payload, models_msg = http_json("http://localhost:7100/llm/models")
        if models_status != "OK":
            record("FAIL" if strict_office else "WARN", f"live MCP model endpoint unavailable: {models_msg}", "./singularity.sh restart mcp-server-demo")
        else:
            data = models_payload.get("data", models_payload) if isinstance(models_payload, dict) else {}
            default_alias = str(data.get("defaultModelAlias") or "").lower()
            rows = data.get("models", []) if isinstance(data, dict) else []
            model_providers = sorted({str(row.get("provider", "")).lower() for row in rows if isinstance(row, dict)})
            if default_alias == "copilot":
                record("OK", "live MCP default model alias is copilot")
            else:
                record("FAIL", f"live MCP default model alias is {default_alias or '(unset)'}, not copilot", "./singularity.sh config mcp-catalog --copilot-only && ./singularity.sh restart mcp-server-demo")
            if model_providers == ["copilot"]:
                record("OK", "live MCP model catalog exposes only Copilot")
            else:
                record("FAIL", f"live MCP model catalog exposes non-Copilot providers: {', '.join(model_providers)}", "./singularity.sh config mcp-catalog --copilot-only && ./singularity.sh restart mcp-server-demo")

    write_doctor_summary(records, failures=failures, warnings=warnings)
    print(f"\nWrote portal doctor summary: {PORTAL_DOCTOR_PATH.relative_to(ROOT)}")

    if failures:
        print(f"\nDoctor finished with {failures} blocking issue(s).")
        sys.exit(1)
    print("\nDoctor finished. Warnings may be fine when services are intentionally stopped.")


def service_name_for_url(name: str) -> str:
    return {
        "portal": "portal",
        "workgraph web": "workgraph-web",
        "blueprint workbench": "blueprint-workbench",
        "agent web": "agent-web",
        "iam": "iam-service",
        "context api": "context-api",
        "llm gateway": "llm-gateway",
        "context memory": "context-memory",
        "metrics ledger": "metrics-ledger",
        "mcp server": "mcp-server-demo",
        "agent runtime": "agent-runtime",
        "prompt composer": "prompt-composer",
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
    if args.copilot_only:
        default_alias = "copilot"
    catalog = [
        {
            "id": "fast",
            "label": "OpenAI fast",
            "provider": "openai",
            "model": args.openai_fast_model,
            "default": default_alias == "fast",
            "maxOutputTokens": 1200,
            "supportsTools": True,
            "costTier": "low",
            "description": "Default low-latency model for routine workflow steps.",
        },
        {
            "id": "balanced",
            "label": "OpenAI balanced",
            "provider": "openai",
            "model": args.openai_balanced_model,
            "default": default_alias == "balanced",
            "maxOutputTokens": 2000,
            "supportsTools": True,
            "costTier": "medium",
            "description": "General-purpose workflow model for agent and workbench tasks.",
        },
        {
            "id": "openrouter-fast",
            "label": "OpenRouter fast",
            "provider": "openrouter",
            "model": args.openrouter_model,
            "default": default_alias == "openrouter-fast",
            "maxOutputTokens": 1200,
            "supportsTools": True,
            "costTier": "low",
            "description": "OpenRouter option when that provider is explicitly configured locally.",
        },
        {
            "id": "anthropic-balanced",
            "label": "Anthropic balanced",
            "provider": "anthropic",
            "model": args.anthropic_model,
            "default": default_alias == "anthropic-balanced",
            "maxOutputTokens": 2000,
            "supportsTools": True,
            "costTier": "medium",
            "description": "Anthropic option when the local MCP server has an Anthropic key.",
        },
        {
            "id": "mock",
            "label": "Mock offline",
            "provider": "mock",
            "model": "mock-fast",
            "default": default_alias == "mock",
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
            set_path(data, "llm.openrouter.apiKey", "")
            set_path(data, "llm.anthropic.apiKey", "")
            set_path(data, "llm.ollama.baseUrl", "")
            set_path(data, "llm.copilot.defaultModel", args.copilot_model)
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
    print("\nRestart MCP after catalog changes:")
    print("  ./singularity.sh restart mcp-server-demo")
    print("Then verify:")
    print("  curl http://localhost:7100/llm/models")


def command_models(_: argparse.Namespace) -> None:
    values = default_values(argparse.Namespace())
    catalog_path = values.get("MCP_LLM_MODEL_CATALOG_PATH") or ".singularity/mcp-models.json"
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
    p_doctor.add_argument("--office-copilot-only", action="store_true", help="Fail unless this laptop is fenced to Copilot-only provider/model access")
    p_doctor.set_defaults(func=command_doctor)

    p_set = sub.add_parser("set", help="Set one canonical config key and rewrite env files")
    p_set.add_argument("key", help="Dotted config key, e.g. llm.openai.apiKey")
    p_set.add_argument("value")
    p_set.add_argument("--no-write", action="store_true")
    p_set.set_defaults(func=command_set)

    p_mcp_runtime = sub.add_parser("mcp", help="Configure the default/local MCP runtime")
    p_mcp_runtime.add_argument("--base-url", default=None)
    p_mcp_runtime.add_argument("--public-base-url", default=None)
    p_mcp_runtime.add_argument("--bearer-token", default=None)
    p_mcp_runtime.add_argument("--sandbox-root", default=None)
    p_mcp_runtime.add_argument("--ast-db-path", default=None)
    p_mcp_runtime.set_defaults(func=command_mcp)

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

    p_mcp = sub.add_parser("mcp-register", help="Register a local MCP server in IAM for a capability")
    p_mcp.add_argument("--capability-id", required=True)
    p_mcp.add_argument("--name", default="Local MCP Server")
    p_mcp.add_argument("--description", default="Configured by Singularity platform config utility")
    p_mcp.add_argument("--base-url", default="http://host.docker.internal:7100")
    p_mcp.add_argument("--bearer-token", default=os.getenv("MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars"))
    p_mcp.add_argument("--protocol", choices=["MCP_HTTP", "MCP_WS"], default="MCP_HTTP")
    p_mcp.add_argument("--iam-base-url", default="http://localhost:8100/api/v1")
    p_mcp.add_argument("--email", default="admin@singularity.local")
    p_mcp.add_argument("--password", default="Admin1234!")
    p_mcp.set_defaults(func=command_mcp_register)

    p_mcp_catalog = sub.add_parser("mcp-catalog", help="Create a local MCP model catalog file and wire env files to it")
    p_mcp_catalog.add_argument("--path", default=".singularity/mcp-models.json")
    p_mcp_catalog.add_argument("--default-alias", choices=["fast", "balanced", "openrouter-fast", "anthropic-balanced", "mock", "copilot"], default="mock")
    p_mcp_catalog.add_argument("--copilot-only", action="store_true", help="Write a catalog containing only the GitHub Copilot alias")
    p_mcp_catalog.add_argument("--copilot-model", default="gpt-4o")
    p_mcp_catalog.add_argument("--openai-fast-model", default="gpt-4o-mini")
    p_mcp_catalog.add_argument("--openai-balanced-model", default="gpt-4o")
    p_mcp_catalog.add_argument("--openrouter-model", default="openai/gpt-4o-mini")
    p_mcp_catalog.add_argument("--anthropic-model", default="claude-sonnet-4-6")
    p_mcp_catalog.set_defaults(func=command_mcp_catalog)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
