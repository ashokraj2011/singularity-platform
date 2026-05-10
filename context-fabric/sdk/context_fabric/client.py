from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import httpx


@dataclass
class ContextFabricClient:
    base_url: str = "http://localhost:8000"
    timeout: float = 240.0

    def respond(self, session_id: str, message: str, agent_id: str = "default-agent",
                provider: str = "mock", model: str = "mock-fast",
                optimization_mode: str = "medium", compare_with_raw: bool = True,
                max_context_tokens: int = 16000, **kwargs: Any) -> dict:
        payload = {
            "session_id": session_id,
            "agent_id": agent_id,
            "message": message,
            "provider": provider,
            "model": model,
            "context_policy": {
                "optimization_mode": optimization_mode,
                "compare_with_raw": compare_with_raw,
                "max_context_tokens": max_context_tokens,
            },
            **kwargs,
        }
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(self.base_url.rstrip("/") + "/chat/respond", json=payload)
            resp.raise_for_status()
            return resp.json()

    def compare(self, session_id: str, message: str, agent_id: str = "default-agent",
                modes: list[str] | None = None, max_context_tokens: int = 16000,
                provider: str = "mock", model: str = "mock-fast") -> dict:
        payload = {
            "session_id": session_id,
            "agent_id": agent_id,
            "message": message,
            "modes": modes or ["none", "conservative", "medium", "aggressive"],
            "max_context_tokens": max_context_tokens,
            "provider": provider,
            "model": model,
        }
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(self.base_url.rstrip("/") + "/context/compare", json=payload)
            resp.raise_for_status()
            return resp.json()

    def dashboard(self) -> dict:
        with httpx.Client(timeout=self.timeout) as client:
            resp = client.get(self.base_url.rstrip("/") + "/metrics/dashboard")
            resp.raise_for_status()
            return resp.json()
