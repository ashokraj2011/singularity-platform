#!/usr/bin/env python3
"""Guard: the configured embedding alias must resolve to an embedding-capable provider.

The LLM gateway only produces embeddings for providers **openai / openrouter / mock**
(context-fabric/services/llm_gateway_service/app/router.py — the `/v1/embeddings`
handler 400s for anything else, including the shipped default `anthropic`). If
`EMBEDDING_MODEL_ALIAS` is unset (embeddings then resolve to the gateway default
alias, which is anthropic) or points at a non-embedding provider, EVERY embedding
call 400s and semantic grounding **silently degrades** to recency/FTS — with no
signal. This guard makes that misconfiguration loud at configure / CI time.

Behaviour mirrors the other bin/check-*.py guards: non-disruptive by default
(WARN), fail-closed under --strict (deploy/prod preflight) or when an explicit
EMBEDDING_MODEL_ALIAS is set to a bad alias.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Providers the gateway can actually produce embeddings for (see router.py).
EMBED_CAPABLE = {"openai", "openrouter", "mock"}


def _load_json(primary: Path, fallback: Path):
    for path in (primary, fallback):
        if path.exists():
            try:
                return json.loads(path.read_text()), path
            except Exception as exc:  # noqa: BLE001 - report, don't crash
                return exc, path
    return None, primary


def _resolve_alias_provider(alias, models):
    for entry in models or []:
        if isinstance(entry, dict) and entry.get("id") == alias:
            return entry.get("provider")
    return None


def _default_alias(models, providers):
    # An explicit default:true catalog entry wins; else providers.defaultModel.
    for entry in models or []:
        if isinstance(entry, dict) and entry.get("default") is True:
            return entry.get("id")
    if isinstance(providers, dict):
        return providers.get("defaultModel")
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero on misconfig (deploy/prod preflight)")
    parser.add_argument("--json", action="store_true", help="emit a JSON record instead of text")
    args = parser.parse_args()

    records: list[dict[str, str]] = []

    def emit(status: str, message: str) -> None:
        records.append({"status": status, "message": message})
        if not args.json:
            stream = sys.stderr if status == "FAIL" else sys.stdout
            print(f"{status:<4} {message}", file=stream)

    def finish(code: int) -> int:
        if args.json:
            print(json.dumps({"records": records}, indent=2))
        return code

    models, models_path = _load_json(
        ROOT / ".singularity/llm-models.json", ROOT / ".singularity/llm-models.json.default"
    )
    providers, _ = _load_json(
        ROOT / ".singularity/llm-providers.json", ROOT / ".singularity/llm-providers.json.default"
    )
    if isinstance(models, Exception):
        emit("WARN", f"could not parse model catalog {models_path}: {models}; skipping embedding-provider check")
        return finish(0)
    if models is None:
        emit("WARN", f"no LLM model catalog found ({models_path}); cannot verify embedding provider")
        return finish(0)

    allowed = set((providers or {}).get("allowedProviders") or []) if isinstance(providers, dict) else set()

    env_alias = (os.getenv("EMBEDDING_MODEL_ALIAS") or "").strip()
    explicit = bool(env_alias)
    alias = env_alias or _default_alias(models, providers)
    source = (
        "EMBEDDING_MODEL_ALIAS"
        if explicit
        else "gateway default alias (EMBEDDING_MODEL_ALIAS unset)"
    )
    hard = explicit or args.strict  # when true, a misconfig FAILs instead of WARNs

    if not alias:
        emit(
            "FAIL" if args.strict else "WARN",
            "no embedding alias and no default alias resolvable; embedding calls will 400 -> "
            "semantic grounding silently degrades to recency/FTS",
        )
        return finish(1 if args.strict else 0)

    provider = _resolve_alias_provider(alias, models)
    if provider is None:
        emit(
            "FAIL" if hard else "WARN",
            f"embedding alias '{alias}' ({source}) is not present in the model catalog {models_path}",
        )
        return finish(1 if hard else 0)

    embed_ok = provider in EMBED_CAPABLE and (not allowed or provider in allowed)
    if embed_ok:
        emit("OK", f"embedding alias '{alias}' ({source}) -> provider '{provider}' is embedding-capable")
        return finish(0)

    if provider not in EMBED_CAPABLE:
        reason = f"provider '{provider}' cannot embed (gateway supports {sorted(EMBED_CAPABLE)})"
    else:
        reason = f"provider '{provider}' is not in allowedProviders {sorted(allowed)}"
    emit(
        "FAIL" if hard else "WARN",
        f"embedding alias '{alias}' ({source}) -> {reason}. Semantic grounding will SILENTLY "
        f"degrade to recency/FTS. Fix: set EMBEDDING_MODEL_ALIAS to an embedding-capable alias "
        f"(use 'embed-mock' for local dev, or add an openai/openrouter embedding model + credential "
        f"+ allowedProviders and point EMBEDDING_MODEL_ALIAS at it).",
    )
    return finish(1 if hard else 0)


if __name__ == "__main__":
    raise SystemExit(main())
