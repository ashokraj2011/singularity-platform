from context_api_service.app.execute_modules.tool_policy import (
    effective_capability_allows_tool,
    filter_tools_by_effective_capabilities,
    local_tool,
)


def test_effective_capability_filter_preserves_legacy_when_no_profile_set():
    tools = [local_tool("read_file", "Read file", {"type": "object"})]

    filtered, warnings = filter_tools_by_effective_capabilities(tools, [])

    assert filtered == tools
    assert warnings == []


def test_effective_capability_filter_fails_closed_when_profile_set_required():
    tools = [local_tool("read_file", "Read file", {"type": "object"})]

    filtered, warnings = filter_tools_by_effective_capabilities(
        tools,
        [],
        require_effective_capabilities=True,
    )

    assert filtered == []
    assert warnings == [
        "all tools hidden: effective capability set is required for this agent profile run"
    ]


def test_effective_capability_filter_allows_matching_invokable_tool():
    tools = [
        local_tool("read_file", "Read file", {"type": "object"}),
        local_tool("apply_patch", "Patch file", {"type": "object"}),
    ]

    filtered, warnings = filter_tools_by_effective_capabilities(
        tools,
        [{"id": "read_file", "permissions": ["read", "invoke"]}],
    )

    assert [tool["name"] for tool in filtered] == ["read_file"]
    assert warnings == [
        "tool apply_patch hidden by effective capability set: no matching capability"
    ]


def test_effective_capability_filter_requires_invoke_for_read_only_tools():
    tools = [local_tool("read_file", "Read file", {"type": "object"})]

    filtered, warnings = filter_tools_by_effective_capabilities(
        tools,
        [{"id": "read_file", "permissions": ["read"], "readOnly": True}],
    )

    assert filtered == []
    assert warnings == [
        "tool read_file hidden by effective capability set: missing invoke"
    ]


def test_effective_capability_direct_gate_fails_closed_when_profile_set_required():
    allowed, reason = effective_capability_allows_tool(
        {"name": "read_file"},
        [],
        require_effective_capabilities=True,
    )

    assert allowed is False
    assert reason == "effective capability set required"


def test_effective_capability_filter_matches_descriptor_capability_id():
    tools = [{
        "name": "github.issue.search",
        "capability_id": "github.issue.read",
        "capability_permissions": ["read", "invoke"],
    }]

    filtered, warnings = filter_tools_by_effective_capabilities(
        tools,
        [{"id": "github.issue.read", "permissions": ["read", "invoke"]}],
    )

    assert filtered == tools
    assert warnings == []


def test_effective_capability_filter_accepts_permission_dicts():
    tools = [local_tool("search_code", "Search code", {"type": "object"})]

    filtered, warnings = filter_tools_by_effective_capabilities(
        tools,
        [{"toolName": "search_code", "permissions": {"read": True, "invoke": True}}],
    )

    assert filtered == tools
    assert warnings == []
