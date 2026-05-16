from context_api_service.app.main import gateway_messages_from_compiled


def test_gateway_messages_do_not_duplicate_current_user_turn():
    messages = gateway_messages_from_compiled(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "same task"},
        ],
        "same task",
    )

    assert messages == [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "same task"},
    ]


def test_gateway_messages_append_user_turn_when_memory_does_not_include_it():
    messages = gateway_messages_from_compiled(
        [{"role": "assistant", "content": "previous answer"}],
        "new task",
    )

    assert messages[-1] == {"role": "user", "content": "new task"}
