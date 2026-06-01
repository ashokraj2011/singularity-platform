"""M99 S0.3 — the four platform-authored receipt models."""
from context_api_service.app.governed.receipts import (
    AutoVerificationReceipt,
    BaselineReceipt,
    GitPreflightReceipt,
    LocalizationReceipt,
    ReceiptKind,
    receipt_for_phase,
)
from context_api_service.app.governed.phase_state import Phase


def test_kinds_registered_and_distinct():
    kinds = {
        ReceiptKind.LOCALIZATION,
        ReceiptKind.BASELINE,
        ReceiptKind.AUTO_VERIFICATION,
        ReceiptKind.GIT_PREFLIGHT,
    }
    assert len(kinds) == 4
    assert ReceiptKind.LOCALIZATION.value == "localization_receipt"
    assert ReceiptKind.BASELINE.value == "baseline_receipt"
    assert ReceiptKind.AUTO_VERIFICATION.value == "auto_verification_receipt"
    assert ReceiptKind.GIT_PREFLIGHT.value == "git_preflight_receipt"


def test_defaults_serialize_clean():
    for cls, kind in (
        (LocalizationReceipt, ReceiptKind.LOCALIZATION),
        (BaselineReceipt, ReceiptKind.BASELINE),
        (AutoVerificationReceipt, ReceiptKind.AUTO_VERIFICATION),
        (GitPreflightReceipt, ReceiptKind.GIT_PREFLIGHT),
    ):
        r = cls()
        d = r.model_dump()
        assert d["kind"] == kind
        assert "created_at" in d  # stamped by _ReceiptBase


def test_localization_receipt_roundtrip():
    r = LocalizationReceipt(
        target_files=["a.py", "b.py"],
        target_symbols=["startsWith"],
        target_tests=["test_a.py"],
        queries=["symbol:startsWith"],
        sources=["find_symbol", "ast_search"],
        summary="found 2 files",
    )
    d = r.model_dump()
    assert d["target_files"] == ["a.py", "b.py"]
    assert d["origin"] == "platform"
    assert LocalizationReceipt.model_validate(d).target_symbols == ["startsWith"]


def test_git_preflight_receipt_codes():
    r = GitPreflightReceipt(
        ok=False,
        remote="origin",
        branch="wi/RULE-1",
        blocked_code="GIT_BRANCH_PROTECTED",
        fix_commands=["open a PR instead of pushing to protected branch"],
        retryable=False,
        has_commit=True,
    )
    assert r.kind == ReceiptKind.GIT_PREFLIGHT
    assert r.blocked_code == "GIT_BRANCH_PROTECTED"


def test_platform_receipts_not_in_phase_routing():
    """The four M99 receipts must never be what the phase-output validator
    expects — they are platform-authored, not agent-submitted."""
    platform_models = {
        LocalizationReceipt,
        BaselineReceipt,
        AutoVerificationReceipt,
        GitPreflightReceipt,
    }
    for phase in Phase:
        for role in (None, "DEVELOPER", "PRODUCT_OWNER", "SECURITY", "DEVOPS", "QA", "ARCHITECT"):
            model = receipt_for_phase(phase, role)
            assert model not in platform_models
