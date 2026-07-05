import httpx
import pytest

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


def test_system_prompt_http_timeout_defaults_for_invalid_values(monkeypatch):
    monkeypatch.delenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", raising=False)
    assert system_prompts._http_timeout_seconds() == 10.0

    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "bad")
    assert system_prompts._http_timeout_seconds() == 10.0

    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "0")
    assert system_prompts._http_timeout_seconds() == 10.0

    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "-5")
    assert system_prompts._http_timeout_seconds() == 10.0

    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "nan")
    assert system_prompts._http_timeout_seconds() == 10.0


def test_system_prompt_http_timeout_accepts_and_clamps_values(monkeypatch):
    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "12.5")
    assert system_prompts._http_timeout_seconds() == 12.5

    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "999999999")
    assert system_prompts._http_timeout_seconds() == 300.0


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    calls: list[tuple[str, str, object | None]] = []
    timeouts: list[float] = []

    def __init__(self, timeout: float):
        self.timeout = timeout
        self.timeouts.append(timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str):
        self.calls.append(("GET", url, None))
        if not self.responses:
            raise AssertionError(f"unexpected GET {url}")
        return self.responses.pop(0)

    async def post(self, url: str, **kwargs):
        self.calls.append(("POST", url, kwargs.get("json")))
        if not self.responses:
            raise AssertionError(f"unexpected POST {url}")
        return self.responses.pop(0)


def _prompt_response(key: str = "compiler") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "success": True,
            "data": {
                "key": key,
                "version": 3,
                "content": "system prompt",
                "jsonSchema": {"type": "object"},
                "modelHint": "mock",
            },
        },
    )


@pytest.mark.asyncio
async def test_system_prompt_fetch_uses_bounded_http_timeout(monkeypatch):
    monkeypatch.setenv("PROMPT_COMPOSER_URL", "http://composer.local/")
    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "12.5")
    FakeAsyncClient.responses = [_prompt_response()]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(system_prompts.httpx, "AsyncClient", FakeAsyncClient)

    result = await system_prompts._fetch_once("compiler", None)

    assert result.content == "system prompt"
    assert FakeAsyncClient.timeouts == [12.5]
    assert FakeAsyncClient.calls == [
        ("GET", "http://composer.local/api/v1/system-prompts/compiler", None)
    ]


@pytest.mark.asyncio
async def test_system_prompt_render_uses_bounded_http_timeout(monkeypatch):
    monkeypatch.setenv("PROMPT_COMPOSER_URL", "http://composer.local")
    monkeypatch.setenv("SYSTEM_PROMPT_HTTP_TIMEOUT_SEC", "999999")
    FakeAsyncClient.responses = [_prompt_response("rendered")]
    FakeAsyncClient.calls = []
    FakeAsyncClient.timeouts = []
    monkeypatch.setattr(system_prompts.httpx, "AsyncClient", FakeAsyncClient)

    result = await system_prompts._fetch_once("rendered", {"name": "Asha"})

    assert result.key == "rendered"
    assert FakeAsyncClient.timeouts == [300.0]
    assert FakeAsyncClient.calls == [
        (
            "POST",
            "http://composer.local/api/v1/system-prompts/rendered/render",
            {"vars": {"name": "Asha"}},
        )
    ]
