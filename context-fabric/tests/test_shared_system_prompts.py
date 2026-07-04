from context_fabric_shared import system_prompts


def test_system_prompt_ttl_defaults_for_invalid_values(monkeypatch):
    monkeypatch.delenv("SYSTEM_PROMPT_CACHE_TTL_SEC", raising=False)
    assert system_prompts._ttl_seconds() == 300

    monkeypatch.setenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "bad")
    assert system_prompts._ttl_seconds() == 300

    monkeypatch.setenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "0")
    assert system_prompts._ttl_seconds() == 300

    monkeypatch.setenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "-5")
    assert system_prompts._ttl_seconds() == 300


def test_system_prompt_ttl_accepts_and_clamps_values(monkeypatch):
    monkeypatch.setenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "42")
    assert system_prompts._ttl_seconds() == 42

    monkeypatch.setenv("SYSTEM_PROMPT_CACHE_TTL_SEC", "999999999")
    assert system_prompts._ttl_seconds() == 24 * 60 * 60
