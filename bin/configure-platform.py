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
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
OWNED_MARKER = "# --- Singularity config utility managed values ---"


SECRET_HINTS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "PASS", "DATABASE")


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
    use_pseudo = bool(getattr(args, "pseudo_iam", False))
    llm_provider = getattr(args, "llm_provider", None) or "openai"
    llm_model = getattr(args, "llm_model", None) or (
        "mock-fast" if llm_provider == "mock"
        else "openai/gpt-4o-mini" if llm_provider == "openrouter"
        else "gpt-4o-mini"
    )
    openai_key = getattr(args, "openai_api_key", None)
    if openai_key is None:
        openai_key = os.getenv("OPENAI_API_KEY", "")
    openrouter_key = getattr(args, "openrouter_api_key", None)
    if openrouter_key is None:
        openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
    mcp_token = getattr(args, "mcp_bearer_token", None) or os.getenv(
        "MCP_BEARER_TOKEN", "demo-bearer-token-must-be-min-16-chars"
    )
    jwt_secret = getattr(args, "jwt_secret", None) or os.getenv(
        "JWT_SECRET", "dev-secret-change-in-prod-min-32-chars!!"
    )
    service_token = getattr(args, "service_token", None) or os.getenv(
        "CONTEXT_FABRIC_SERVICE_TOKEN", "dev-context-fabric-service-token"
    )
    audit_token = getattr(args, "audit_token", None) or os.getenv(
        "AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token"
    )
    sandbox_root = getattr(args, "mcp_sandbox_root", None) or os.getenv(
        "MCP_SANDBOX_ROOT", str(ROOT)
    )

    iam_base_default = "http://localhost:8101/api/v1" if use_pseudo else "http://localhost:8100/api/v1"
    iam_service_default = "http://localhost:8101" if use_pseudo else "http://localhost:8100"
    iam_base = getattr(args, "iam_base_url", None) or os.getenv("IAM_BASE_URL", iam_base_default)
    iam_service = getattr(args, "iam_service_url", None) or os.getenv("IAM_SERVICE_URL", iam_service_default)

    return {
        "JWT_SECRET": jwt_secret,
        "LOCAL_SUPER_ADMIN_EMAIL": "admin@singularity.local",
        "LOCAL_SUPER_ADMIN_PASSWORD": "Admin1234!",
        "AUTH_PROVIDER": "iam",
        "IAM_BASE_URL": iam_base,
        "IAM_SERVICE_URL": iam_service,
        "IAM_DATABASE_URL": getattr(args, "iam_database_url", None)
        or os.getenv("IAM_DATABASE_URL", "postgresql+asyncpg://singularity:singularity@localhost:5433/singularity_iam"),
        "AGENT_TOOLS_DATABASE_URL": getattr(args, "agent_tools_database_url", None)
        or os.getenv("AGENT_TOOLS_DATABASE_URL", "postgresql://postgres:singularity@localhost:5432/singularity"),
        "WORKGRAPH_DATABASE_URL": getattr(args, "workgraph_database_url", None)
        or os.getenv("WORKGRAPH_DATABASE_URL", "postgresql://workgraph:workgraph_secret@localhost:5434/workgraph"),
        "CONTEXT_FABRIC_SERVICE_TOKEN": service_token,
        "AUDIT_GOV_SERVICE_TOKEN": audit_token,
        "PROMPT_COMPOSER_URL": getattr(args, "prompt_composer_url", None)
        or os.getenv("PROMPT_COMPOSER_URL", "http://localhost:3004"),
        "AGENT_RUNTIME_URL": getattr(args, "agent_runtime_url", None)
        or os.getenv("AGENT_RUNTIME_URL", "http://localhost:3003"),
        "TOOL_SERVICE_URL": getattr(args, "tool_service_url", None)
        or os.getenv("TOOL_SERVICE_URL", "http://localhost:3002"),
        "AGENT_SERVICE_URL": getattr(args, "agent_service_url", None)
        or os.getenv("AGENT_SERVICE_URL", "http://localhost:3001"),
        "CONTEXT_FABRIC_URL": getattr(args, "context_fabric_url", None)
        or os.getenv("CONTEXT_FABRIC_URL", "http://localhost:8000"),
        "BLUEPRINT_WORKBENCH_URL": getattr(args, "blueprint_workbench_url", None)
        or os.getenv("BLUEPRINT_WORKBENCH_URL", "http://localhost:5176"),
        "MCP_SERVER_URL": getattr(args, "mcp_server_url", None)
        or os.getenv("MCP_SERVER_URL", "http://localhost:7100"),
        "MCP_PUBLIC_BASE_URL": getattr(args, "mcp_public_base_url", None)
        or os.getenv("MCP_PUBLIC_BASE_URL", "http://host.docker.internal:7100"),
        "MCP_BEARER_TOKEN": mcp_token,
        "MCP_DEMO_BEARER_TOKEN": mcp_token,
        "MCP_LLM_PROVIDER": llm_provider,
        "MCP_LLM_MODEL": llm_model,
        "MCP_LLM_MODEL_CATALOG_JSON": getattr(args, "mcp_model_catalog_json", None)
        or os.getenv("MCP_LLM_MODEL_CATALOG_JSON", ""),
        "MCP_LLM_MODEL_CATALOG_PATH": getattr(args, "mcp_model_catalog_path", None)
        or os.getenv("MCP_LLM_MODEL_CATALOG_PATH", ""),
        "LLM_PROVIDER": llm_provider,
        "LLM_MODEL": llm_model,
        "OPENAI_API_KEY": openai_key,
        "OPENAI_BASE_URL": getattr(args, "openai_base_url", None) or "https://api.openai.com/v1",
        "OPENAI_DEFAULT_MODEL": llm_model if llm_provider == "openai" else "gpt-4o-mini",
        "OPENAI_COMPATIBLE_API_KEY": openai_key,
        "OPENAI_COMPATIBLE_BASE_URL": getattr(args, "openai_base_url", None) or "https://api.openai.com/v1",
        "OPENROUTER_API_KEY": openrouter_key,
        "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENROUTER_APP_NAME": "Context Fabric",
        "OPENROUTER_SITE_URL": "http://localhost:8000",
        "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
        "SUMMARIZER_PROVIDER": "mock" if llm_provider == "mock" else "openai_compatible",
        "SUMMARIZER_MODEL": "mock-summarizer" if llm_provider == "mock" else llm_model,
        "MCP_SANDBOX_ROOT": sandbox_root,
        "MCP_AST_DB_PATH": f"{sandbox_root.rstrip('/')}/.singularity/mcp-ast.sqlite",
        "MCP_AST_MAX_FILE_BYTES": "200000",
        "MCP_AST_MAX_WORKSPACE_BYTES": "24000000",
        "MCP_AST_MAX_SYMBOLS": "250000",
        "MCP_WORK_BRANCH_PREFIX": "sg",
    }


def for_docker_host(url: str) -> str:
    return url.replace("://localhost", "://host.docker.internal").replace(
        "://127.0.0.1", "://host.docker.internal"
    )


def target_envs(values: dict[str, str]) -> dict[Path, dict[str, str]]:
    return {
        ROOT / ".env": {
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
                "MCP_DEMO_BEARER_TOKEN",
                "MCP_LLM_PROVIDER",
                "MCP_LLM_MODEL",
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
                "OLLAMA_BASE_URL",
                "MCP_SANDBOX_ROOT",
                "MCP_AST_DB_PATH",
                "MCP_AST_MAX_FILE_BYTES",
                "MCP_AST_MAX_WORKSPACE_BYTES",
                "MCP_AST_MAX_SYMBOLS",
                "MCP_WORK_BRANCH_PREFIX",
            ]
        },
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
            "OPENROUTER_API_KEY": values["OPENROUTER_API_KEY"],
            "OPENROUTER_BASE_URL": values["OPENROUTER_BASE_URL"],
            "OPENROUTER_APP_NAME": values["OPENROUTER_APP_NAME"],
            "OPENROUTER_SITE_URL": values["OPENROUTER_SITE_URL"],
            "OPENAI_COMPATIBLE_API_KEY": values["OPENAI_COMPATIBLE_API_KEY"],
            "OPENAI_COMPATIBLE_BASE_URL": values["OPENAI_COMPATIBLE_BASE_URL"],
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
            "MCP_LLM_MODEL_CATALOG_JSON": values["MCP_LLM_MODEL_CATALOG_JSON"],
            "MCP_LLM_MODEL_CATALOG_PATH": values["MCP_LLM_MODEL_CATALOG_PATH"],
            "OPENAI_API_KEY": values["OPENAI_API_KEY"],
            "OPENAI_BASE_URL": values["OPENAI_BASE_URL"],
            "OPENAI_DEFAULT_MODEL": values["OPENAI_DEFAULT_MODEL"],
            "OPENAI_COMPATIBLE_API_KEY": values["OPENAI_COMPATIBLE_API_KEY"],
            "OPENAI_COMPATIBLE_BASE_URL": values["OPENAI_COMPATIBLE_BASE_URL"],
            "OPENROUTER_API_KEY": values["OPENROUTER_API_KEY"],
            "OPENROUTER_BASE_URL": values["OPENROUTER_BASE_URL"],
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
        write_env(path, updates, dry_run=args.dry_run)
    if args.dry_run:
        return
    print("\nDone. Restart affected containers after env changes:")
    print("  ./singularity.sh restart context-api")
    print("  ./singularity.sh restart llm-gateway")
    print("  ./singularity.sh restart mcp-server-demo")
    print("  ./singularity.sh restart workgraph-api")
    print("  ./singularity.sh restart workgraph-web")
    print("  ./singularity.sh restart blueprint-workbench")


def command_interactive(args: argparse.Namespace) -> None:
    print("Singularity configuration wizard\n")
    provider = prompt_choice("LLM provider", ["openai", "openrouter", "ollama", "mock"], "openai")
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
        "LLM_PROVIDER",
        "LLM_MODEL",
        "OPENAI_API_KEY",
        "OPENAI_COMPATIBLE_API_KEY",
        "OPENROUTER_API_KEY",
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


def command_doctor(_: argparse.Namespace) -> None:
    failures = 0
    print("Singularity configuration doctor\n")

    for path in [
        ROOT / ".env",
        ROOT / "singularity-iam-service/.env",
        ROOT / "context-fabric/.env",
        ROOT / "mcp-server/.env",
        ROOT / "agent-and-tools/.env",
        ROOT / "workgraph-studio/apps/api/.env",
    ]:
        if path.exists():
            print(f"OK   env file exists: {path.relative_to(ROOT)}")
        else:
            print(f"WARN env file missing: {path.relative_to(ROOT)}")

    checks = [
        ("agent-and-tools db", "localhost", 5432),
        ("iam db", "localhost", 5433),
        ("workgraph db", "localhost", 5434),
    ]
    for name, host, port in checks:
        if socket_open(host, port):
            print(f"OK   {name} tcp {host}:{port}")
        else:
            print(f"WARN {name} tcp {host}:{port} closed")

    urls = [
        ("portal", "http://localhost:5180"),
        ("workgraph web", "http://localhost:5174"),
        ("blueprint workbench", "http://localhost:5176"),
        ("agent web", "http://localhost:3000"),
        ("iam", "http://localhost:8100/health"),
        ("context api", "http://localhost:8000/health"),
        ("llm gateway", "http://localhost:8001/health"),
        ("mcp server", "http://localhost:7100/health"),
    ]
    for name, url in urls:
        status, msg = http_check(name, url)
        print(f"{status:<4} {msg}")
        if status == "FAIL":
            failures += 1

    merged: dict[str, str] = {}
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
    if provider == "openai" and not (merged.get("OPENAI_API_KEY") or merged.get("OPENAI_COMPATIBLE_API_KEY")):
        print("FAIL OpenAI provider selected but no OpenAI key is configured")
        failures += 1
    elif provider == "openrouter" and not merged.get("OPENROUTER_API_KEY"):
        print("FAIL OpenRouter provider selected but no OpenRouter key is configured")
        failures += 1
    else:
        print(f"OK   LLM provider configuration: {provider}")

    mcp_token = merged.get("MCP_DEMO_BEARER_TOKEN") or merged.get("MCP_BEARER_TOKEN", "")
    if len(mcp_token) < 16:
        print("FAIL MCP bearer token must be at least 16 characters")
        failures += 1
    else:
        print("OK   MCP bearer token length")

    if failures:
        print(f"\nDoctor finished with {failures} blocking issue(s).")
        sys.exit(1)
    print("\nDoctor finished. Warnings may be fine when services are intentionally stopped.")


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
            "description": "OpenRouter fallback when that provider is configured locally.",
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
    if not any(row["default"] for row in catalog):
        catalog[0]["default"] = True

    out.write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")

    updates = {
        "MCP_LLM_MODEL_CATALOG_PATH": str(out),
        "MCP_LLM_MODEL_CATALOG_JSON": "",
    }
    write_env(ROOT / ".env", updates, dry_run=False)
    write_env(ROOT / "mcp-server/.env", updates, dry_run=False)
    print("\nRestart MCP after catalog changes:")
    print("  ./singularity.sh restart mcp-server-demo")
    print("Then verify:")
    print("  curl http://localhost:7100/llm/models")


def add_common_write_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--llm-provider", choices=["mock", "openai", "openrouter", "ollama"], default=None)
    parser.add_argument("--llm-model", default=None)
    parser.add_argument("--openai-api-key", default=None)
    parser.add_argument("--openai-base-url", default=None)
    parser.add_argument("--openrouter-api-key", default=None)
    parser.add_argument("--mcp-bearer-token", default=None)
    parser.add_argument("--mcp-sandbox-root", default=None)
    parser.add_argument("--mcp-model-catalog-json", default=None)
    parser.add_argument("--mcp-model-catalog-path", default=None)
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

    p_write = sub.add_parser("write", help="Write the standard env files")
    add_common_write_args(p_write)
    p_write.add_argument("--dry-run", action="store_true")
    p_write.set_defaults(func=command_write)

    p_interactive = sub.add_parser("interactive", help="Prompt for common settings, then write env files")
    p_interactive.set_defaults(func=command_interactive)

    p_show = sub.add_parser("show", help="Show current relevant settings with secrets masked")
    p_show.set_defaults(func=command_show)

    p_doctor = sub.add_parser("doctor", help="Validate env files, ports, service URLs, and key presence")
    p_doctor.set_defaults(func=command_doctor)

    p_export = sub.add_parser("export", help="Print shell exports for the standard profile")
    add_common_write_args(p_export)
    p_export.set_defaults(func=command_export)

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
    p_mcp_catalog.add_argument("--default-alias", choices=["fast", "balanced", "openrouter-fast", "anthropic-balanced", "mock"], default="fast")
    p_mcp_catalog.add_argument("--openai-fast-model", default="gpt-4o-mini")
    p_mcp_catalog.add_argument("--openai-balanced-model", default="gpt-4o")
    p_mcp_catalog.add_argument("--openrouter-model", default="openai/gpt-4o-mini")
    p_mcp_catalog.add_argument("--anthropic-model", default="claude-sonnet-4-6")
    p_mcp_catalog.set_defaults(func=command_mcp_catalog)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
