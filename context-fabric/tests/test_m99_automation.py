"""M99 Phase 0 — env+policy automation resolver tests."""
import pytest

from context_api_service.app.governed.governed_automation import (
    automation_enabled,
    env_flag_enabled,
)
from context_api_service.app.governed.stage_execution_policy import StageExecutionPolicy

_ENV_FOR = {
    "localize": "CF_AGENTIC_CODING_V2_ENABLED",
    "baseline": "CF_AUTO_BASELINE_ENABLED",
    "verify": "CF_AUTO_VERIFY_ENABLED",
    "preflight": "CF_GIT_PREFLIGHT_ENABLED",
}
_POLICY_KW = {
    "localize": "auto_localize",
    "baseline": "auto_baseline",
    "verify": "auto_verify",
    "preflight": "git_preflight_required",
}


def _clear_env(monkeypatch):
    for name in _ENV_FOR.values():
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("WORKGRAPH_FORCE_GOVERNED_CODING", raising=False)


@pytest.mark.parametrize("behavior", list(_ENV_FOR))
def test_phase0_default_off_is_noop(monkeypatch, behavior):
    """With no env flags set, every behavior is off even if policy opts in."""
    _clear_env(monkeypatch)
    pol = StageExecutionPolicy(stage_key="DEVELOP", **{_POLICY_KW[behavior]: True})
    assert automation_enabled(pol, behavior) is False


@pytest.mark.parametrize("behavior", list(_ENV_FOR))
def test_env_on_plus_policy_true_enables(monkeypatch, behavior):
    _clear_env(monkeypatch)
    monkeypatch.setenv(_ENV_FOR[behavior], "1")
    pol = StageExecutionPolicy(stage_key="DEVELOP", **{_POLICY_KW[behavior]: True})
    assert automation_enabled(pol, behavior) is True


@pytest.mark.parametrize("behavior", list(_ENV_FOR))
def test_env_on_but_policy_false_or_none_stays_off(monkeypatch, behavior):
    _clear_env(monkeypatch)
    monkeypatch.setenv(_ENV_FOR[behavior], "1")
    # policy flag explicitly False
    pol_false = StageExecutionPolicy(stage_key="DEVELOP", **{_POLICY_KW[behavior]: False})
    assert automation_enabled(pol_false, behavior) is False
    # policy flag left as default None
    pol_none = StageExecutionPolicy(stage_key="DEVELOP")
    assert automation_enabled(pol_none, behavior) is False
    # no policy at all
    assert automation_enabled(None, behavior) is False


def test_env_flag_falsey_values(monkeypatch):
    _clear_env(monkeypatch)
    for val in ("0", "false", "no", "off", "", "NONE"):
        monkeypatch.setenv("CF_AUTO_VERIFY_ENABLED", val)
        assert env_flag_enabled("CF_AUTO_VERIFY_ENABLED") is False
    for val in ("1", "true", "YES", "on"):
        monkeypatch.setenv("CF_AUTO_VERIFY_ENABLED", val)
        assert env_flag_enabled("CF_AUTO_VERIFY_ENABLED") is True


def test_camelcase_policy_alias_still_resolves(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("CF_AGENTIC_CODING_V2_ENABLED", "1")
    pol = StageExecutionPolicy.model_validate({"stage_key": "DEVELOP", "autoLocalize": True})
    assert automation_enabled(pol, "localize") is True
