"""P1 #3 Tier 1 — regression tests for the JWT_SECRET production boot guard.

IAM signs device/runtime/user/service JWTs with a shared HS256 JWT_SECRET
(app/auth/jwt.py). config.py refuses to start a production-class IAM when
JWT_SECRET is unset, too short, or a known dev default. These tests lock that in
so a config refactor can't silently drop JWT_SECRET from the guarded set and
re-open token forgery.

Run: cd singularity-iam-service && PYTHONPATH=. python3 -m pytest \
        tests/test_jwt_secret_guard.py -q
"""
from __future__ import annotations

import importlib

import pytest

from app import config

_DEFAULT = "changeme_dev_only_min_32_chars_long!!"
_ENV_SIGNALS = ("APP_ENV", "ENVIRONMENT", "NODE_ENV", "SINGULARITY_ENV")


def _clear_env_signals(monkeypatch) -> None:
    for name in _ENV_SIGNALS:
        monkeypatch.delenv(name, raising=False)


def test_guard_rejects_default_jwt_secret_in_prod(monkeypatch):
    _clear_env_signals(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        config._assert_prod_secret("JWT_SECRET", _DEFAULT)


def test_guard_rejects_unset_and_short_in_prod(monkeypatch):
    _clear_env_signals(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        config._assert_prod_secret("JWT_SECRET", None)
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        config._assert_prod_secret("JWT_SECRET", "short")


def test_guard_allows_strong_secret_in_prod(monkeypatch):
    _clear_env_signals(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    config._assert_prod_secret("JWT_SECRET", "x" * 40)  # must not raise


def test_guard_is_noop_outside_prod(monkeypatch):
    _clear_env_signals(monkeypatch)  # no prod signal at all
    config._assert_prod_secret("JWT_SECRET", _DEFAULT)  # must not raise in dev


def test_config_import_fails_fast_in_prod_with_default(monkeypatch):
    """Wiring guard: importing config under a prod env with the default
    JWT_SECRET must fail at import time (the module-level guard call)."""
    _clear_env_signals(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", _DEFAULT)
    try:
        with pytest.raises(RuntimeError, match="JWT_SECRET"):
            importlib.reload(config)
    finally:
        # Restore a clean dev module state so other tests are unaffected.
        _clear_env_signals(monkeypatch)
        monkeypatch.delenv("JWT_SECRET", raising=False)
        importlib.reload(config)
