"""M99 S1.1 — pre-ACT localization sweep tests."""
import pytest

from context_api_service.app.governed import localization as loc
from context_api_service.app.governed.dispatch import ToolDispatchError
from context_api_service.app.governed.receipts import LocalizationReceipt


class _FakeOutcome:
    def __init__(self, result, tool_success=True):
        self.result = result
        self.tool_success = tool_success
        self.tool_error = None
        self.duration_ms = 1
        self.tool_invocation_id = "inv"


def _patch_dispatch(monkeypatch, responses):
    """responses: dict tool_name -> _FakeOutcome | Exception."""
    async def fake_dispatch(tool_name, args, **kwargs):
        r = responses.get(tool_name)
        if isinstance(r, Exception):
            raise r
        if r is None:
            return _FakeOutcome({}, tool_success=False)
        return r
    monkeypatch.setattr(loc, "dispatch_tool", fake_dispatch)


@pytest.mark.asyncio
async def test_localization_collects_and_splits_tests(monkeypatch):
    _patch_dispatch(monkeypatch, {
        "repo_map": _FakeOutcome({"files": ["src/a.py", "src/b.py"]}),
        "find_symbol": _FakeOutcome({"symbols": ["startsWith"], "files": ["src/ops.py"]}),
        "search_code": _FakeOutcome({"matches": ["tests/test_ops.py"]}),
        "code_context_package": _FakeOutcome({"packageId": "pkg-123"}),
    })
    res = await loc.synthesize_localization(
        task_text="add startsWith operator",
        work_item_id="wi-1", workspace_id=None, run_context={}, bearer=None,
    )
    assert "src/a.py" in res.target_files and "src/ops.py" in res.target_files
    assert "tests/test_ops.py" in res.target_tests
    assert "tests/test_ops.py" not in res.target_files  # split out
    assert res.target_symbols == ["startsWith"]
    assert res.code_context_package_id == "pkg-123"
    assert set(res.sources) == {"repo_map", "find_symbol", "search_code", "code_context_package"}
    assert res.found_anything


@pytest.mark.asyncio
async def test_localization_never_raises_on_dispatch_error(monkeypatch):
    _patch_dispatch(monkeypatch, {
        "repo_map": ToolDispatchError("boom"),
        "find_symbol": _FakeOutcome({"files": ["src/only.py"]}),
        "search_code": ToolDispatchError("boom"),
        "code_context_package": ToolDispatchError("boom"),
    })
    res = await loc.synthesize_localization(
        task_text="x", work_item_id=None, workspace_id="ws", run_context=None, bearer=None,
    )
    assert res.target_files == ["src/only.py"]
    assert res.sources == ["find_symbol"]


@pytest.mark.asyncio
async def test_localization_empty_when_nothing_found(monkeypatch):
    _patch_dispatch(monkeypatch, {
        "repo_map": _FakeOutcome({}, tool_success=False),
        "find_symbol": _FakeOutcome({}, tool_success=False),
        "search_code": _FakeOutcome({}, tool_success=False),
        "code_context_package": _FakeOutcome({}, tool_success=False),
    })
    res = await loc.synthesize_localization(
        task_text="x", work_item_id="wi", workspace_id=None, run_context={}, bearer=None,
    )
    assert not res.found_anything
    assert res.reason is not None
    assert res.sources == []


@pytest.mark.asyncio
async def test_result_maps_to_receipt(monkeypatch):
    _patch_dispatch(monkeypatch, {
        "repo_map": _FakeOutcome({"files": ["a.py"]}),
        "find_symbol": _FakeOutcome({}, tool_success=False),
        "search_code": _FakeOutcome({}, tool_success=False),
        "code_context_package": _FakeOutcome({}, tool_success=False),
    })
    res = await loc.synthesize_localization(
        task_text="t", work_item_id="wi", workspace_id=None, run_context={}, bearer=None,
    )
    receipt = LocalizationReceipt(**res.to_receipt_payload())
    assert receipt.target_files == ["a.py"]
    assert receipt.origin == "platform"
    assert receipt.model_dump()["kind"] == "localization_receipt"


@pytest.mark.asyncio
async def test_dedup_and_cap(monkeypatch):
    big = [f"f{i}.py" for i in range(80)] + ["f0.py", "f1.py"]  # dupes + over cap
    _patch_dispatch(monkeypatch, {
        "repo_map": _FakeOutcome({"files": big}),
        "find_symbol": _FakeOutcome({}, tool_success=False),
        "search_code": _FakeOutcome({}, tool_success=False),
        "code_context_package": _FakeOutcome({}, tool_success=False),
    })
    res = await loc.synthesize_localization(
        task_text="t", work_item_id="wi", workspace_id=None, run_context={}, bearer=None,
    )
    assert len(res.target_files) <= loc._MAX_TARGETS
    assert len(res.target_files) == len(set(res.target_files))
