#!/usr/bin/env python3
"""Verify deploy secret names before a production-class release.

GitHub does not expose secret values, only names. This check therefore proves
that a target GitHub Environment is populated with every required secret name.
Value strength is still enforced on the target/release env by
bin/check-deploy-env.sh.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "docs/deploy-required-secrets.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--env-file", action="append", default=[], type=Path, help="Check required names exist in a local env/release file")
    parser.add_argument("--github-environment", help="GitHub Environment name to inspect, for example production or staging")
    parser.add_argument("--repo", help="GitHub repo as owner/name. Defaults to gh repo view in the current checkout.")
    parser.add_argument("--require-oidc", action="store_true", help="Also require OIDC SSO secret names for IAM_AUTH_MODE=oidc deployments")
    parser.add_argument("--skip-github", action="store_true", help="Only validate the manifest and any --env-file inputs")
    return parser.parse_args()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"FAIL could not read manifest {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"FAIL manifest {path} must be a JSON object")
    return data


def secret_names(manifest: dict[str, Any], field: str) -> list[str]:
    raw = manifest.get(field)
    if not isinstance(raw, list):
        raise SystemExit(f"FAIL manifest field {field!r} must be a list")
    names: list[str] = []
    seen: set[str] = set()
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SystemExit(f"FAIL {field}[{idx}] must be an object")
        name = item.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            raise SystemExit(f"FAIL {field}[{idx}].name must be an uppercase env key")
        if name in seen:
            raise SystemExit(f"FAIL duplicate secret name in {field}: {name}")
        seen.add(name)
        names.append(name)
        purpose = item.get("purpose")
        if not isinstance(purpose, str) or not purpose.strip():
            raise SystemExit(f"FAIL {field}[{idx}].purpose is required")
    return names


def parse_env_file(path: Path) -> set[str]:
    names: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        raise SystemExit(f"FAIL could not read env file {path}: {exc}") from exc
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        try:
            shlex.split(value, comments=True, posix=True)
        except ValueError as exc:
            raise SystemExit(f"FAIL could not parse env value for {key} in {path}: {exc}") from exc
        names.add(key)
    return names


def run_json(cmd: list[str]) -> Any:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise SystemExit(f"FAIL command failed: {' '.join(cmd)}\n{detail}")
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FAIL command did not return JSON: {' '.join(cmd)}: {exc}") from exc


def resolve_repo(explicit: str | None) -> str:
    if explicit:
        if not re.fullmatch(r"[^/\s]+/[^/\s]+", explicit):
            raise SystemExit("FAIL --repo must be owner/name")
        return explicit
    data = run_json(["gh", "repo", "view", "--json", "nameWithOwner"])
    repo = data.get("nameWithOwner")
    if not isinstance(repo, str) or "/" not in repo:
        raise SystemExit("FAIL could not resolve GitHub repo; pass --repo owner/name")
    return repo


def github_environment_secret_names(repo: str, environment: str) -> set[str]:
    data = run_json([
        "gh",
        "api",
        f"repos/{repo}/environments/{environment}/secrets",
        "--paginate",
    ])
    secrets = data.get("secrets") if isinstance(data, dict) else None
    if not isinstance(secrets, list):
        raise SystemExit("FAIL GitHub environment secrets response did not include a secrets list")
    names = {
        item.get("name")
        for item in secrets
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    return {name for name in names if isinstance(name, str)}


def report_missing(surface: str, available: set[str], required: list[str]) -> int:
    missing = [name for name in required if name not in available]
    if missing:
        print(f"FAIL {surface} missing required deploy secret names:", file=sys.stderr)
        for name in missing:
            print(f"  - {name}", file=sys.stderr)
        return 1
    print(f"OK {surface} has {len(required)} required deploy secret names")
    return 0


def main() -> int:
    args = parse_args()
    manifest = load_manifest(args.manifest)
    required = secret_names(manifest, "requiredSecrets")
    optional = secret_names(manifest, "optionalSecrets")
    if args.require_oidc:
        oidc_required = ["IAM_AUTH_MODE", "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI"]
        missing_from_manifest = [name for name in oidc_required if name not in optional and name not in required]
        if missing_from_manifest:
            raise SystemExit(f"FAIL OIDC required name(s) missing from manifest: {', '.join(missing_from_manifest)}")
        required = [*required, *[name for name in oidc_required if name not in required]]
    failures = 0

    suffix = " including OIDC SSO names" if args.require_oidc else ""
    print(f"OK deploy secret manifest valid ({len(required)} required names{suffix})")

    for env_file in args.env_file:
        failures |= report_missing(f"env file {env_file}", parse_env_file(env_file), required)

    if args.github_environment and not args.skip_github:
        repo = resolve_repo(args.repo or os.getenv("GH_REPO"))
        names = github_environment_secret_names(repo, args.github_environment)
        failures |= report_missing(f"GitHub environment {repo}:{args.github_environment}", names, required)
    elif args.github_environment and args.skip_github:
        print("WARN --github-environment was provided with --skip-github; GitHub API check skipped")

    if not args.env_file and not args.github_environment:
        print("INFO no --env-file or --github-environment provided; manifest validation only")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
