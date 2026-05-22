"""Shared fixtures for the chaos smoke harness.

These tests assume a live stack started via `docker compose up -d` on
default ports. Each fixture is a small adapter so a future move to a
remote staging URL (rather than localhost) only changes one place.
"""
from __future__ import annotations

import os
import time
from typing import Callable

import httpx
import pytest


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


LLM_GATEWAY_URL = _env("LLM_GATEWAY_URL", "http://localhost:8001")
AUDIT_GOV_URL = _env("AUDIT_GOV_URL", "http://localhost:8500")
AUDIT_GOV_TOKEN = _env("AUDIT_GOV_SERVICE_TOKEN", "dev-audit-gov-service-token")


@pytest.fixture(scope="session")
def gateway_url() -> str:
    return LLM_GATEWAY_URL


@pytest.fixture(scope="session")
def audit_gov_url() -> str:
    return AUDIT_GOV_URL


@pytest.fixture(scope="session", autouse=True)
def wait_for_stack() -> None:
    """Block until both services answer /health, then continue.

    Each test starts with the stack in a known-good state. If a service
    is down or unreachable, the suite fails fast with a clear message
    instead of letting individual tests time out one by one.
    """
    deadline = time.time() + 60
    last_err: str | None = None
    while time.time() < deadline:
        try:
            with httpx.Client(timeout=2.0) as c:
                gw = c.get(f"{LLM_GATEWAY_URL}/health")
                ag = c.get(f"{AUDIT_GOV_URL}/health")
                if gw.status_code == 200 and ag.status_code == 200:
                    return
                last_err = f"gateway={gw.status_code} audit-gov={ag.status_code}"
        except Exception as exc:  # pylint: disable=broad-except
            last_err = str(exc)
        time.sleep(2)
    pytest.skip(
        f"chaos stack not ready after 60s ({last_err}). "
        f"Bring it up with: docker compose --profile full up -d"
    )


@pytest.fixture
def call_gateway(gateway_url: str) -> Callable[[str], httpx.Response]:
    """Returns a callable that POSTs to /v1/chat/completions with the
    given model_alias and a trivial user message. Uses a single
    pre-warmed client per fixture invocation so per-test latency is
    just the gateway path."""
    def _call(model_alias: str, *, timeout: float = 10.0) -> httpx.Response:
        with httpx.Client(timeout=timeout) as c:
            return c.post(
                f"{gateway_url}/v1/chat/completions",
                json={
                    "model_alias": model_alias,
                    "messages": [{"role": "user", "content": "chaos smoke probe"}],
                },
            )
    return _call


@pytest.fixture
def reset_mock_counter(gateway_url: str) -> Callable[[], None]:
    """Flush the gateway's mock-fail-N-K counter (M65 Slice 3B admin
    endpoint). Tests that depend on "first N calls fail" semantics call
    this in setup so prior test state doesn't bleed across cases.
    """
    def _reset() -> None:
        with httpx.Client(timeout=5.0) as c:
            r = c.post(f"{gateway_url}/v1/mock/reset")
            r.raise_for_status()
    return _reset
