"""Wire-format regression tests for tool_calls round-trip across providers.

Pinned by the 2026-05-24 multi-provider sweep. The Anthropic AND OpenAI
provider converters BOTH had the same broken assumption: tool_calls
arrived JSON-stringified inside `m.content`. The real wire format ships
tool_calls as a sibling of content (the dedicated `tool_calls` field on
ChatMessage). When the converter couldn't find them, every tool round-
trip silently dropped the tool_use block — on Anthropic this surfaced
as a 400 (tool_result has no parent tool_use); on OpenAI/Copilot it
surfaced subtler as the model fabricating context.

These tests run the in-process converter functions directly (no HTTP
mock needed) and assert that:

  1. The `tool_calls` field on ChatMessage is the canonical source.
  2. Both gateway-flat ({id, name, args}) AND OpenAI-nested
     ({id, type, function:{name, arguments}}) input shapes are
     accepted and emit the provider's expected output shape.
  3. tool_call_id round-trips intact through tool messages.

Provider coverage:
  - Anthropic (Claude direct, Bedrock, GCP Vertex)
  - OpenAI (direct + Azure OpenAI deployments)
  - OpenRouter (routes through openai_compat)
  - Copilot (GitHub Copilot Chat API; gh copilot CLI calls this)
"""
from __future__ import annotations

import json

from services.llm_gateway_service.app.providers.anthropic import _to_anthropic
from services.llm_gateway_service.app.providers.openai_compat import _to_openai_messages
from services.llm_gateway_service.app.types import ChatMessage


# ── Helpers ──────────────────────────────────────────────────────────────


def _assistant_with_flat_tool_call(tool_id: str = "tc-abc") -> ChatMessage:
    """Gateway-flat shape: {id, name, args} sitting directly in tool_calls."""
    return ChatMessage(
        role="assistant",
        content="Let me look at the file.",
        tool_calls=[{"id": tool_id, "name": "read_file", "args": {"path": "x.py"}}],
    )


def _assistant_with_openai_nested_tool_call(tool_id: str = "tc-xyz") -> ChatMessage:
    """OpenAI-nested shape: {id, type, function: {name, arguments}}.
    This is what stage_driver actually builds today."""
    return ChatMessage(
        role="assistant",
        content="Let me look at the file.",
        tool_calls=[{
            "id": tool_id,
            "type": "function",
            "function": {"name": "read_file", "arguments": json.dumps({"path": "x.py"})},
        }],
    )


def _tool_result_msg(tool_id: str = "tc-abc", body: str = '{"contents":"..."}'):
    return ChatMessage(
        role="tool",
        content=body,
        tool_call_id=tool_id,
        tool_name="read_file",
    )


# ── Anthropic converter ──────────────────────────────────────────────────


def test_anthropic_accepts_flat_tool_calls_field():
    """tool_calls as a sibling of content (the canonical shape) must
    produce a tool_use block. Regression for the original Anthropic bug."""
    system, out = _to_anthropic([_assistant_with_flat_tool_call(), _tool_result_msg()])
    assert len(out) == 2
    assert out[0]["role"] == "assistant"
    assert isinstance(out[0]["content"], list)
    use_block = out[0]["content"][0]
    assert use_block["type"] == "tool_use"
    assert use_block["id"] == "tc-abc"
    assert use_block["name"] == "read_file"
    assert use_block["input"] == {"path": "x.py"}
    # Tool result must reference the same id so Anthropic accepts the pair.
    assert out[1]["role"] == "user"
    assert out[1]["content"][0]["type"] == "tool_result"
    assert out[1]["content"][0]["tool_use_id"] == "tc-abc"


def test_anthropic_accepts_openai_nested_tool_calls():
    """OpenAI-nested shape (the shape stage_driver actually produces)
    should still convert correctly. Regression for the second half of
    the same bug — flat works but nested previously dropped."""
    system, out = _to_anthropic([_assistant_with_openai_nested_tool_call("tc-xyz"), _tool_result_msg("tc-xyz")])
    use_block = out[0]["content"][0]
    assert use_block["type"] == "tool_use"
    assert use_block["id"] == "tc-xyz"
    assert use_block["name"] == "read_file"
    # `arguments` was JSON-stringified in the nested shape; converter
    # should have parsed it back into the object Anthropic expects.
    assert use_block["input"] == {"path": "x.py"}


def test_anthropic_legacy_json_in_content_still_works():
    """Backward-compat: a caller that still embeds tool_calls inside
    content as JSON should not be broken."""
    legacy_msg = ChatMessage(
        role="assistant",
        content=json.dumps({"tool_calls": [{"id": "legacy-1", "name": "ping", "args": {}}]}),
    )
    system, out = _to_anthropic([legacy_msg])
    assert out[0]["content"][0]["type"] == "tool_use"
    assert out[0]["content"][0]["id"] == "legacy-1"


def test_anthropic_assistant_content_strips_trailing_whitespace():
    """Anthropic 400s on assistant content ending with whitespace.
    Defensive strip lives in the converter."""
    msg = ChatMessage(role="assistant", content="Done. ")
    system, out = _to_anthropic([msg])
    assert out[0]["content"] == "Done."


def test_anthropic_assistant_content_strips_lone_space():
    """Haiku occasionally emits content=' ' alongside a tool_call.
    Strip handles this too."""
    msg = ChatMessage(role="assistant", content=" ", tool_calls=[
        {"id": "tc-1", "name": "x", "args": {}},
    ])
    system, out = _to_anthropic([msg])
    # When tool_calls drive the message, content is replaced by the
    # tool_use block list anyway; the strip is belt-and-suspenders.
    assert isinstance(out[0]["content"], list)
    assert out[0]["content"][0]["type"] == "tool_use"


# ── OpenAI / OpenRouter / Copilot converter ─────────────────────────────


def test_openai_accepts_flat_tool_calls_field():
    """The same canonical shape works for OpenAI. Regression for the
    multi-provider sweep — this previously silently dropped the call."""
    out = _to_openai_messages([_assistant_with_flat_tool_call()])
    assert out[0]["role"] == "assistant"
    assert out[0]["tool_calls"]
    tc = out[0]["tool_calls"][0]
    assert tc["type"] == "function"
    assert tc["id"] == "tc-abc"
    assert tc["function"]["name"] == "read_file"
    # OpenAI expects arguments as a JSON STRING — verify stringification.
    assert json.loads(tc["function"]["arguments"]) == {"path": "x.py"}


def test_openai_accepts_openai_nested_tool_calls_field():
    """The shape stage_driver actually sends (already OpenAI-nested) must
    pass through cleanly — no double-wrapping, args string preserved."""
    out = _to_openai_messages([_assistant_with_openai_nested_tool_call()])
    tc = out[0]["tool_calls"][0]
    assert tc["id"] == "tc-xyz"
    assert tc["function"]["name"] == "read_file"
    # arguments was already a JSON string; the converter shouldn't have
    # double-encoded it.
    assert json.loads(tc["function"]["arguments"]) == {"path": "x.py"}


def test_openai_tool_message_keeps_tool_call_id():
    """OpenAI requires tool_call_id on tool messages. Without it the model
    can't pair the result with its prior call."""
    out = _to_openai_messages([_tool_result_msg("tc-abc")])
    assert out[0]["role"] == "tool"
    assert out[0]["tool_call_id"] == "tc-abc"
    assert out[0]["name"] == "read_file"


def test_openai_legacy_json_in_content_still_works():
    """Any caller still on the pre-2026-05-24 wire still works."""
    legacy_msg = ChatMessage(
        role="assistant",
        content=json.dumps({"tool_calls": [{"id": "legacy-2", "name": "ping", "args": {"a": 1}}]}),
    )
    out = _to_openai_messages([legacy_msg])
    assert out[0]["tool_calls"][0]["id"] == "legacy-2"
    assert json.loads(out[0]["tool_calls"][0]["function"]["arguments"]) == {"a": 1}


def test_openai_assistant_plain_text_passes_through():
    """No tool_calls, no content surgery — pure pass-through for chat-
    only flows (gh copilot CLI's `explain` mode hits this path)."""
    msg = ChatMessage(role="assistant", content="Here's what I think...")
    out = _to_openai_messages([msg])
    assert out[0] == {"role": "assistant", "content": "Here's what I think..."}


def test_openai_handles_none_args_gracefully():
    """If a future caller sends `args: null`, the converter should emit
    `arguments: '{}'` rather than crashing or sending `null`."""
    msg = ChatMessage(
        role="assistant",
        content="",
        tool_calls=[{"id": "tc-null", "name": "x", "args": None}],
    )
    out = _to_openai_messages([msg])
    assert out[0]["tool_calls"][0]["function"]["arguments"] == "{}"


def test_openai_handles_string_args_passthrough():
    """If the caller pre-stringified args (some clients do), don't
    double-encode."""
    msg = ChatMessage(
        role="assistant",
        content="",
        tool_calls=[{"id": "tc-str", "name": "x", "args": '{"k":"v"}'}],
    )
    out = _to_openai_messages([msg])
    assert out[0]["tool_calls"][0]["function"]["arguments"] == '{"k":"v"}'


# ── Cross-provider parity ────────────────────────────────────────────────


def test_parity_same_input_produces_correctly_shaped_output_each_side():
    """The same internal ChatMessage list should yield Anthropic-shaped
    output via _to_anthropic AND OpenAI-shaped output via
    _to_openai_messages. Sanity check that both providers see the
    same tool_call_id so an upstream caller can switch providers without
    rewriting the message history."""
    msgs = [
        _assistant_with_openai_nested_tool_call("shared-id-1"),
        _tool_result_msg("shared-id-1"),
    ]
    _, ant_out = _to_anthropic(msgs)
    oai_out = _to_openai_messages(msgs)
    # Anthropic: tool_use.id matches tool_result.tool_use_id
    assert ant_out[0]["content"][0]["id"] == "shared-id-1"
    assert ant_out[1]["content"][0]["tool_use_id"] == "shared-id-1"
    # OpenAI: assistant tool_calls[0].id matches tool.tool_call_id
    assert oai_out[0]["tool_calls"][0]["id"] == "shared-id-1"
    assert oai_out[1]["tool_call_id"] == "shared-id-1"
