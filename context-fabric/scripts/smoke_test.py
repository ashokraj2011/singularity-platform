from __future__ import annotations

import json
import time
import httpx

BASE = "http://localhost:8000"
SESSION = f"smoke-{int(time.time())}"

messages = [
    "We are designing Context Fabric as a standalone context optimization gateway.",
    "It should split LLM gateway, context memory, summarization, and metrics ledger services.",
    "It should compare raw and optimized token usage on every call.",
    "It should support medium and aggressive optimization modes.",
    "Now summarize the architecture decisions and suggest the next backend step."
]

with httpx.Client(timeout=240.0) as client:
    for m in messages:
        resp = client.post(f"{BASE}/chat/respond", json={
            "session_id": SESSION,
            "agent_id": "developer-agent",
            "message": m,
            "provider": "mock",
            "model": "mock-fast",
            "context_policy": {"optimization_mode": "medium", "compare_with_raw": True, "max_context_tokens": 12000}
        })
        resp.raise_for_status()
        data = resp.json()
        print("--- response ---")
        print(data["response"][:300])
        print("optimization:", json.dumps(data["optimization"], indent=2))

    compare = client.post(f"{BASE}/context/compare", json={
        "session_id": SESSION,
        "agent_id": "developer-agent",
        "message": "Continue with the DB schema and service APIs.",
        "modes": ["none", "conservative", "medium", "aggressive"]
    })
    compare.raise_for_status()
    print("--- compare ---")
    print(json.dumps(compare.json(), indent=2))

    dashboard = client.get(f"{BASE}/metrics/dashboard")
    dashboard.raise_for_status()
    print("--- dashboard ---")
    print(json.dumps(dashboard.json(), indent=2))
