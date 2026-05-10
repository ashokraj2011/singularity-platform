import uuid
import requests


BASE_URL = "http://localhost:8000"


def test_context_fabric_saves_tokens_with_medium_mode():
    session_id = f"token-saving-test-{uuid.uuid4()}"
    agent_id = "developer-agent"

    long_context = """
    Context Fabric is a model-agnostic context optimization gateway.
    It stores raw messages, creates rolling summaries, retrieves durable memory,
    compiles optimized context, calls LLM providers, and records token savings.
    The platform separates context-api-service, llm-gateway-service,
    context-memory-service, and metrics-ledger-service.
    The main goal is to avoid sending the entire conversation history to the model
    on every call. Instead, it should send recent messages, rolling summary,
    relevant memory, and current task.
    """

    # Build a long session history using the public API and mock model.
    # This avoids spending OpenAI tokens.
    for i in range(14):
        response = requests.post(
            f"{BASE_URL}/chat/respond",
            json={
                "session_id": session_id,
                "agent_id": agent_id,
                "message": f"""
                Message number {i}.
                Please remember this architecture detail:
                {long_context}
                Also remember that token saving must be measured by comparing
                raw_input_tokens against optimized_input_tokens.
                """,
                "provider": "mock",
                "model": "mock-fast",
                "temperature": 0.2,
                "max_output_tokens": 200,
                "context_policy": {
                    "optimization_mode": "medium",
                    "compare_with_raw": True,
                    "max_context_tokens": 16000,
                },
            },
            timeout=30,
        )

        assert response.status_code == 200, response.text

    # Compare raw vs optimized context without calling a real LLM.
    compare_response = requests.post(
        f"{BASE_URL}/context/compare",
        json={
            "session_id": session_id,
            "agent_id": agent_id,
            "message": "Summarize what Context Fabric is doing and explain token savings.",
            "modes": ["none", "conservative", "medium", "aggressive"],
        },
        timeout=30,
    )
    print(compare_response)
    assert compare_response.status_code == 200, compare_response.text

    data = compare_response.json()
    comparisons = {item["mode"]: item for item in data["comparisons"]}


    raw_tokens = comparisons["none"]["optimized_input_tokens"]
    medium_tokens = comparisons["medium"]["optimized_input_tokens"]
    assert raw_tokens > 0
    assert medium_tokens > 0

    assert medium_tokens < raw_tokens

    tokens_saved = raw_tokens - medium_tokens
    percent_saved = tokens_saved / raw_tokens * 100

    print(f"Raw tokens: {raw_tokens}")
    print(f"Medium optimized tokens: {medium_tokens}")
    print(f"Tokens saved: {tokens_saved}")
    print(f"Percent saved: {percent_saved:.2f}%")

    assert tokens_saved > 0
    assert percent_saved > 30
