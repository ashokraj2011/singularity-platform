"""Placement policy tests — cloud vs laptop for MCP/LLM + enterprise override."""
from __future__ import annotations

import pytest

from context_api_service.app.governed import placement as p


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ENTERPRISE_LLM_GATEWAY", raising=False)
    monkeypatch.delenv("PREFER_LAPTOP_LLM", raising=False)


@pytest.mark.parametrize(
    "val,expected",
    [("true", True), ("1", True), ("yes", True), ("on", True), ("TRUE", True),
     ("false", False), ("", False), ("nope", False)],
)
def test_enterprise_mode_env(monkeypatch, val, expected):
    monkeypatch.setenv("ENTERPRISE_LLM_GATEWAY", val)
    assert p.enterprise_mode() is expected


def test_enterprise_mode_default_off():
    assert p.enterprise_mode() is False


def test_mcp_laptop_allowed_passthrough_when_not_enterprise():
    assert p.mcp_laptop_allowed(None) is None
    assert p.mcp_laptop_allowed(True) is True
    assert p.mcp_laptop_allowed(False) is False


def test_mcp_laptop_allowed_enterprise_forces_cloud(monkeypatch):
    monkeypatch.setenv("ENTERPRISE_LLM_GATEWAY", "true")
    assert p.mcp_laptop_allowed(True) is False
    assert p.mcp_laptop_allowed(None) is False
    assert p.mcp_laptop_allowed(False) is False


def test_llm_laptop_target_defaults_to_cloud():
    assert p.llm_laptop_target(None) is None
    assert p.llm_laptop_target({}) is None
    assert p.llm_laptop_target({"user_id": "u1"}) is None            # no prefer flag
    assert p.llm_laptop_target({"prefer_laptop_llm": True}) is None  # no user_id


def test_llm_laptop_target_returns_user_when_opted_in():
    assert p.llm_laptop_target({"prefer_laptop_llm": True, "user_id": "u1"}) == "u1"
    assert p.llm_laptop_target({"prefer_laptop_llm": True, "userId": "u2"}) == "u2"


def test_llm_laptop_target_enterprise_forces_cloud(monkeypatch):
    monkeypatch.setenv("ENTERPRISE_LLM_GATEWAY", "true")
    assert p.llm_laptop_target({"prefer_laptop_llm": True, "user_id": "u1"}) is None


def test_llm_laptop_target_env_optin(monkeypatch):
    monkeypatch.setenv("PREFER_LAPTOP_LLM", "true")
    # deployment-wide opt-in routes to the launching user's laptop without the per-run flag
    assert p.llm_laptop_target({"user_id": "u1"}) == "u1"
    assert p.llm_laptop_target({}) is None  # still needs a user_id


def test_llm_laptop_target_env_optin_loses_to_enterprise(monkeypatch):
    monkeypatch.setenv("PREFER_LAPTOP_LLM", "true")
    monkeypatch.setenv("ENTERPRISE_LLM_GATEWAY", "true")
    assert p.llm_laptop_target({"user_id": "u1"}) is None
