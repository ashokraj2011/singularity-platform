from context_fabric_shared.token_counter import count_text_tokens, count_message_tokens


def test_count_text_tokens():
    assert count_text_tokens("hello world") > 0


def test_count_message_tokens():
    assert count_message_tokens([{"role": "user", "content": "hello"}]) > 0
