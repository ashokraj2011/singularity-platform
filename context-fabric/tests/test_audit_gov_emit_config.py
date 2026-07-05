from __future__ import annotations

import importlib
from pathlib import Path

from context_api_service.app import audit_gov_emit


def _reload_with_timeout(monkeypatch, value: str | None):
    if value is None:
        monkeypatch.delenv("CONTEXT_FABRIC_AUDIT_GOV_EMIT_TIMEOUT_SEC", raising=False)
    else:
        monkeypatch.setenv("CONTEXT_FABRIC_AUDIT_GOV_EMIT_TIMEOUT_SEC", value)
    return importlib.reload(audit_gov_emit)


def test_audit_gov_emit_timeout_is_bounded_env(monkeypatch):
    assert _reload_with_timeout(monkeypatch, None).AUDIT_GOV_EMIT_TIMEOUT_SEC == 5.0
    assert _reload_with_timeout(monkeypatch, "bad").AUDIT_GOV_EMIT_TIMEOUT_SEC == 5.0
    assert _reload_with_timeout(monkeypatch, "0").AUDIT_GOV_EMIT_TIMEOUT_SEC == 5.0
    assert _reload_with_timeout(monkeypatch, "12.5").AUDIT_GOV_EMIT_TIMEOUT_SEC == 12.5
    assert _reload_with_timeout(monkeypatch, "9999").AUDIT_GOV_EMIT_TIMEOUT_SEC == 300.0


def test_audit_gov_emit_uses_bounded_timeout_constant():
    source = Path("services/context_api_service/app/audit_gov_emit.py").read_text()
    assert "from .env_config import bounded_float_env" in source
    assert "CONTEXT_FABRIC_AUDIT_GOV_EMIT_TIMEOUT_SEC" in source
    assert (
        'AUDIT_GOV_EMIT_TIMEOUT_SEC = bounded_float_env(\n'
        '    "CONTEXT_FABRIC_AUDIT_GOV_EMIT_TIMEOUT_SEC",'
    ) in source
    assert source.count("httpx.AsyncClient(timeout=AUDIT_GOV_EMIT_TIMEOUT_SEC)") == 2
    assert "TIMEOUT_S = 5.0" not in source
    assert "httpx.AsyncClient(timeout=5.0)" not in source
