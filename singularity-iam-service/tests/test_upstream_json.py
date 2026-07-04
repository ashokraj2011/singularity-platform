import pytest

from app.upstream_json import response_error_message, response_json_object, upstream_snippet


class FakeResponse:
    def __init__(self, text: str, status_code: int = 200):
        self.text = text
        self.status_code = status_code


def test_response_json_object_accepts_objects():
    assert response_json_object(FakeResponse('{"ok": true}'), "unit") == {"ok": True}


def test_response_json_object_rejects_invalid_json_with_snippet():
    with pytest.raises(ValueError, match=r"unit returned invalid JSON \(502\).*Internal Server Error"):
        response_json_object(FakeResponse("Internal Server Error", 502), "unit")


def test_response_json_object_rejects_arrays():
    with pytest.raises(ValueError, match=r"unit returned invalid JSON object \(200\)"):
        response_json_object(FakeResponse("[1,2,3]"), "unit")


def test_response_error_message_prefers_provider_error_description():
    msg = response_error_message(FakeResponse('{"error_description": "code expired"}', 400), "OIDC token exchange")
    assert msg == "OIDC token exchange failed (400): code expired"


def test_upstream_snippet_compacts_whitespace():
    assert upstream_snippet("  a\n\n  b\tc  ", 20) == "a b c"
