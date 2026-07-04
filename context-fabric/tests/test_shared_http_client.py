import httpx
import pytest

from context_fabric_shared import http_client


class FakeAsyncClient:
    responses: list[httpx.Response] = []
    calls: list[tuple[str, str]]

    def __init__(self, timeout: float):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url: str):
        self.calls.append(("GET", url))
        return self.responses.pop(0)

    async def post(self, url: str, json: dict):
        self.calls.append(("POST", url))
        return self.responses.pop(0)


def _response(status: int, text: str, url: str = "http://svc.local/data") -> httpx.Response:
    return httpx.Response(status, text=text, request=httpx.Request("GET", url))


@pytest.mark.asyncio
async def test_get_json_returns_object(monkeypatch):
    FakeAsyncClient.responses = [_response(200, '{"ok": true}')]
    FakeAsyncClient.calls = []
    monkeypatch.setattr(http_client.httpx, "AsyncClient", FakeAsyncClient)

    assert await http_client.get_json("http://svc.local/data") == {"ok": True}
    assert FakeAsyncClient.calls == [("GET", "http://svc.local/data")]


@pytest.mark.asyncio
async def test_get_json_rejects_malformed_success_body(monkeypatch):
    FakeAsyncClient.responses = [_response(200, "Internal Server Error")]
    FakeAsyncClient.calls = []
    monkeypatch.setattr(http_client.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match="returned invalid JSON"):
        await http_client.get_json("http://svc.local/data")


@pytest.mark.asyncio
async def test_post_json_rejects_non_object_success_body(monkeypatch):
    FakeAsyncClient.responses = [_response(200, "[1, 2, 3]")]
    FakeAsyncClient.calls = []
    monkeypatch.setattr(http_client.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(ValueError, match="returned non-object JSON"):
        await http_client.post_json("http://svc.local/data", {"hello": "world"})
