from context_fabric_shared.token_counter import (
    count_text_tokens,
    count_message_tokens,
    trim_text_to_tokens,
)


def test_count_text_tokens():
    assert count_text_tokens("hello world") > 0


def test_count_message_tokens():
    assert count_message_tokens([{"role": "user", "content": "hello"}]) > 0


def test_trim_text_to_tokens_within_budget():
    text = "the quick brown fox jumps over the lazy dog " * 100
    for budget in (1, 5, 25, 100):
        trimmed = trim_text_to_tokens(text, budget)
        assert count_text_tokens(trimmed) <= budget


def test_trim_text_to_tokens_noop_when_fits():
    assert trim_text_to_tokens("hello", 100) == "hello"


def test_trim_text_to_tokens_zero_budget():
    assert trim_text_to_tokens("anything", 0) == ""
