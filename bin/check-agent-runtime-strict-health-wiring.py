#!/usr/bin/env python3
"""Verify operator smoke paths probe Agent Runtime strict health."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


bare_metal = read("bin/bare-metal.sh")
docker_core = read("bin/docker-core.sh")
doctor = read("bin/doctor.sh")

require(
    '"http://localhost:3003/healthz/strict|200,304|10"' in bare_metal,
    "bare-metal smoke must probe Agent Runtime /healthz/strict",
)
require(
    '"agent-runtime strict|http://localhost:3003/healthz/strict"' in doctor,
    "doctor services must include Agent Runtime strict health",
)
require(
    'wait_for_url "agent-runtime strict health" "http://localhost:${AGENT_RUNTIME_PORT:-3003}/healthz/strict" 180'
    in docker_core,
    "docker-core up must wait for Agent Runtime strict health",
)
require(
    'check_url "agent-runtime strict" "http://localhost:${AGENT_RUNTIME_PORT:-3003}/healthz/strict"'
    in docker_core,
    "docker-core smoke must probe Agent Runtime strict health",
)

print("agent-runtime strict health wiring checks passed")
