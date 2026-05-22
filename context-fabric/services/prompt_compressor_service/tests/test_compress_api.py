"""M62 Slice B — API-level tests for /api/v1/compress.

These tests do NOT load the real llmlingua model. Instead they:
  - exercise the validation layer with pure pydantic input
  - monkey-patch the compressor singleton with a stub that returns
    a canned `compress_prompt` result

This keeps the test suite runnable in seconds without pulling 600MB
of model state into pytest. End-to-end smoke against the real model
lives in Slice C as an operator runbook step.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.prompt_compressor_service.app import compressor as compressor_module
from services.prompt_compressor_service.app.main import app


class _StubCompressor:
    """Mimics enough of llmlingua.PromptCompressor for the API tests."""

    def __init__(self, output: str = "shorter text", origin_tokens: int = 40, compressed_tokens: int = 12):
        self.output = output
        self.origin_tokens = origin_tokens
        self.compressed_tokens = compressed_tokens
        self.last_kwargs: dict = {}

    def compress_prompt(self, **kwargs):
        self.last_kwargs = kwargs
        return {
            "compressed_prompt": self.output,
            "origin_tokens": self.origin_tokens,
            "compressed_tokens": self.compressed_tokens,
        }


@pytest.fixture
def stub_compressor(monkeypatch):
    stub = _StubCompressor()
    monkeypatch.setattr(compressor_module, "_compressor", stub)
    monkeypatch.setattr(compressor_module, "_load_failed_reason", None)
    return stub


@pytest.fixture
def client():
    return TestClient(app)


# ---- Validation -------------------------------------------------------

def test_rejects_missing_target_and_rate(client, stub_compressor):
    """Caller must specify exactly one of target_token / rate."""
    resp = client.post("/api/v1/compress", json={"text": "x" * 200})
    assert resp.status_code == 422
    assert "exactly one of" in resp.text


def test_rejects_both_target_and_rate(client, stub_compressor):
    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 200, "target_token": 50, "rate": 0.5},
    )
    assert resp.status_code == 422


def test_rejects_target_below_floor(client, stub_compressor):
    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 200, "target_token": 5},
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"]["code"] == "TARGET_TOKEN_TOO_LOW"


def test_rejects_oversized_text(client, stub_compressor):
    huge = "a" * 300_000
    resp = client.post(
        "/api/v1/compress",
        json={"text": huge, "target_token": 100},
    )
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "TEXT_TOO_LARGE"


def test_rejects_rate_out_of_bounds(client, stub_compressor):
    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 200, "rate": 0.01},  # below ge=0.05
    )
    assert resp.status_code == 422


# ---- Short-circuit ----------------------------------------------------

def test_short_input_returns_original_with_warning(client, stub_compressor):
    """Inputs under 100 chars don't get compressed — they round-trip
    with a warning so the caller knows the no-op was intentional.
    """
    resp = client.post(
        "/api/v1/compress",
        json={"text": "hi", "target_token": 50},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["compressed_text"] == "hi"
    assert body["ratio"] == 1.0
    assert "below 100 chars" in body["warning"]
    assert body["receipt_id"].startswith("cmprx-")


# ---- Happy path -------------------------------------------------------

def test_compress_returns_structured_receipt(client, stub_compressor):
    text = "x" * 500
    resp = client.post(
        "/api/v1/compress",
        json={"text": text, "target_token": 12},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["compressed_text"] == "shorter text"
    assert body["original_tokens"] == 40
    assert body["compressed_tokens"] == 12
    assert body["ratio"] == 0.3
    assert body["receipt_id"].startswith("cmprx-")
    assert body["warning"] is None
    # Stub records the kwargs it received
    assert stub_compressor.last_kwargs["context"] == text
    assert stub_compressor.last_kwargs["target_token"] == 12


def test_compress_passes_force_tokens(client, stub_compressor):
    resp = client.post(
        "/api/v1/compress",
        json={
            "text": "x" * 500,
            "target_token": 12,
            "force_tokens": ["RuleEngineService", "src/main/Foo.java"],
        },
    )
    assert resp.status_code == 200
    assert stub_compressor.last_kwargs["force_tokens"] == [
        "RuleEngineService",
        "src/main/Foo.java",
    ]


def test_compress_warns_on_target_miss(client, stub_compressor):
    """When the compressor overshoots the target by >25%, the response
    carries a warning string so the caller can log/alert.
    """
    stub_compressor.compressed_tokens = 200  # asked for 50, got 200
    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 500, "target_token": 50},
    )
    body = resp.json()
    assert body["warning"] is not None
    assert "missed target_token=50" in body["warning"]


# ---- Failure modes ----------------------------------------------------

def test_compressor_failure_returns_422(client, monkeypatch):
    """llmlingua exceptions are collapsed to a single 422
    COMPRESSION_FAILED. Callers can't usefully distinguish them.
    """
    class _Boomer:
        def compress_prompt(self, **kwargs):
            raise ValueError("model thinks the prompt is too short")

    monkeypatch.setattr(compressor_module, "_compressor", _Boomer())
    monkeypatch.setattr(compressor_module, "_load_failed_reason", None)

    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 500, "target_token": 50},
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"]["code"] == "COMPRESSION_FAILED"
    assert "ValueError" in body["detail"]["message"]


def test_load_failure_returns_503(client, monkeypatch):
    """If load_compressor() raises, the endpoint surfaces 503 so the
    caller's circuit breaker can fall back to the un-compressed layer.
    """
    monkeypatch.setattr(compressor_module, "_compressor", None)
    monkeypatch.setattr(compressor_module, "_load_failed_reason", "ImportError: no torch")

    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 500, "target_token": 50},
    )
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "COMPRESSOR_UNAVAILABLE"


# ---- Disabled-at-service-level ---------------------------------------

def test_returns_409_when_disabled(client, monkeypatch):
    from services.prompt_compressor_service.app import config as cfg

    monkeypatch.setattr(cfg.settings, "compression_enabled", False)
    resp = client.post(
        "/api/v1/compress",
        json={"text": "x" * 500, "target_token": 50},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "COMPRESSION_DISABLED"
