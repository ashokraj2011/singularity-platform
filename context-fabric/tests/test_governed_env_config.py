from __future__ import annotations

import logging

from context_api_service.app.governed.env_config import bounded_float_env, bounded_int_env


def test_bounded_float_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("TEST_FLOAT_ENV", raising=False)
    assert bounded_float_env(
        "TEST_FLOAT_ENV",
        default=10.0,
        min_value=1.0,
        max_value=100.0,
        logger=logging.getLogger("test"),
    ) == 10.0

    monkeypatch.setenv("TEST_FLOAT_ENV", "not-a-float")
    assert bounded_float_env(
        "TEST_FLOAT_ENV",
        default=10.0,
        min_value=1.0,
        max_value=100.0,
    ) == 10.0

    monkeypatch.setenv("TEST_FLOAT_ENV", "0")
    assert bounded_float_env(
        "TEST_FLOAT_ENV",
        default=10.0,
        min_value=1.0,
        max_value=100.0,
    ) == 10.0

    monkeypatch.setenv("TEST_FLOAT_ENV", "42.5")
    assert bounded_float_env(
        "TEST_FLOAT_ENV",
        default=10.0,
        min_value=1.0,
        max_value=100.0,
    ) == 42.5

    monkeypatch.setenv("TEST_FLOAT_ENV", "999999")
    assert bounded_float_env(
        "TEST_FLOAT_ENV",
        default=10.0,
        min_value=1.0,
        max_value=100.0,
    ) == 100.0


def test_bounded_int_env_defaults_and_clamps(monkeypatch):
    monkeypatch.delenv("TEST_INT_ENV", raising=False)
    assert bounded_int_env(
        "TEST_INT_ENV",
        default=2,
        min_value=0,
        max_value=10,
        logger=logging.getLogger("test"),
    ) == 2

    monkeypatch.setenv("TEST_INT_ENV", "not-an-int")
    assert bounded_int_env(
        "TEST_INT_ENV",
        default=2,
        min_value=0,
        max_value=10,
    ) == 2

    monkeypatch.setenv("TEST_INT_ENV", "-1")
    assert bounded_int_env(
        "TEST_INT_ENV",
        default=2,
        min_value=0,
        max_value=10,
    ) == 2

    monkeypatch.setenv("TEST_INT_ENV", "7")
    assert bounded_int_env(
        "TEST_INT_ENV",
        default=2,
        min_value=0,
        max_value=10,
    ) == 7

    monkeypatch.setenv("TEST_INT_ENV", "999")
    assert bounded_int_env(
        "TEST_INT_ENV",
        default=2,
        min_value=0,
        max_value=10,
    ) == 10


def test_prompt_composer_knob_bounds(monkeypatch):
    monkeypatch.setenv("STAGE_PROMPT_CACHE_TTL_SEC", "999999")
    assert bounded_float_env(
        "STAGE_PROMPT_CACHE_TTL_SEC",
        default=60.0,
        min_value=1.0,
        max_value=86_400.0,
    ) == 86_400.0

    monkeypatch.setenv("STAGE_PROMPT_HTTP_TIMEOUT_SEC", "0")
    assert bounded_float_env(
        "STAGE_PROMPT_HTTP_TIMEOUT_SEC",
        default=15.0,
        min_value=1.0,
        max_value=300.0,
    ) == 15.0

    monkeypatch.setenv("STAGE_POLICY_CACHE_TTL_SEC", "bad")
    assert bounded_float_env(
        "STAGE_POLICY_CACHE_TTL_SEC",
        default=300.0,
        min_value=1.0,
        max_value=86_400.0,
    ) == 300.0

    monkeypatch.setenv("STAGE_POLICY_HTTP_TIMEOUT_SEC", "450")
    assert bounded_float_env(
        "STAGE_POLICY_HTTP_TIMEOUT_SEC",
        default=10.0,
        min_value=1.0,
        max_value=300.0,
    ) == 300.0


def test_governed_stage_driver_knob_bounds(monkeypatch):
    monkeypatch.setenv("GOVERNED_STAGE_WALL_CLOCK_SEC", "0")
    assert bounded_float_env(
        "GOVERNED_STAGE_WALL_CLOCK_SEC",
        default=780.0,
        min_value=0.0,
        max_value=86_400.0,
    ) == 0.0

    monkeypatch.setenv("GOVERNED_STAGE_WALL_CLOCK_SEC", "not-a-float")
    assert bounded_float_env(
        "GOVERNED_STAGE_WALL_CLOCK_SEC",
        default=780.0,
        min_value=0.0,
        max_value=86_400.0,
    ) == 780.0

    monkeypatch.setenv("GOVERNED_STAGE_WALL_CLOCK_SEC", "999999")
    assert bounded_float_env(
        "GOVERNED_STAGE_WALL_CLOCK_SEC",
        default=780.0,
        min_value=0.0,
        max_value=86_400.0,
    ) == 86_400.0

    monkeypatch.setenv("GOVERNED_LLM_RETRY_ATTEMPTS", "999")
    assert bounded_int_env(
        "GOVERNED_LLM_RETRY_ATTEMPTS",
        default=2,
        min_value=0,
        max_value=10,
    ) == 10

    monkeypatch.setenv("GOVERNED_LLM_RETRY_BASE_DELAY_SEC", "0")
    assert bounded_float_env(
        "GOVERNED_LLM_RETRY_BASE_DELAY_SEC",
        default=1.0,
        min_value=0.1,
        max_value=60.0,
    ) == 1.0

    monkeypatch.setenv("GOVERNED_LLM_RETRY_BASE_DELAY_SEC", "120")
    assert bounded_float_env(
        "GOVERNED_LLM_RETRY_BASE_DELAY_SEC",
        default=1.0,
        min_value=0.1,
        max_value=60.0,
    ) == 60.0
