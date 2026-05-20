import inspect

from context_api_service.app import execute as execute_module
from context_api_service.app.execute import _normalize_tool_for_mcp


def test_tool_normalization_matches_mcp_schema():
    tool, warnings = _normalize_tool_for_mcp({
        "tool_name": "code.apply_patch",
        "description": "Apply a patch",
        "input_schema": {"type": "object", "required": ["patch"]},
        "execution_target": "remote-service",
        "risk_level": "danger",
        "requires_approval": True,
    })

    assert tool == {
        "name": "code.apply_patch",
        "description": "Apply a patch",
        "input_schema": {"type": "object", "required": ["patch"]},
        "execution_target": "SERVER",
        "requires_approval": True,
        "risk_level": "LOW",
    }
    assert any("unsupported execution_target" in warning for warning in warnings)
    assert any("unsupported risk_level" in warning for warning in warnings)


def test_tool_normalization_skips_unnamed_tools():
    tool, warnings = _normalize_tool_for_mcp({"description": "No executable name"})

    assert tool is None
    assert warnings == []


def test_execute_discovers_tools_once_before_prompt_composition():
    source = inspect.getsource(execute_module.execute)

    assert '"toolDescriptors": tools_for_mcp' in source
    assert '"tools": tools_for_mcp' in source
    assert '"includeLocalTools": (' in source
    assert 'req.limits.get("include_local_tools", False)' in source
    assert source.index("tools_for_mcp: list") < source.index("compose_payload =")
    assert source.index('"toolDescriptors": tools_for_mcp') < source.index('"tools": tools_for_mcp')
