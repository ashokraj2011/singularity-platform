"""P4 — mode handling: warn (don't silently fall back) on unknown mode,
surface requested_mode, and stay quiet for valid modes.
"""
from __future__ import annotations

import logging

from context_memory_service.app import context_compiler as cc
from conftest import make_rows, make_summary, make_memory_items


def test_unknown_mode_warns_and_falls_back_to_medium(patch_repo, caplog):
    patch_repo(messages=make_rows(8), summary=make_summary(["g", "c"]), memory=make_memory_items(3))
    with caplog.at_level(logging.WARNING):
        out = cc.compile_context("s1", "a1", "hello", "agressive", 16000)  # typo
    opt = out["optimization"]
    assert opt["mode"] == "medium"
    assert opt["requested_mode"] == "agressive"
    assert "mode_warning" in opt and "agressive" in opt["mode_warning"]
    # A warning was logged (observable, not silent).
    assert any("agressive" in r.message for r in caplog.records if r.levelno >= logging.WARNING)


def test_valid_mode_no_warning(patch_repo, caplog):
    patch_repo(messages=make_rows(8), summary=make_summary(["g", "c"]), memory=make_memory_items(3))
    with caplog.at_level(logging.WARNING):
        out = cc.compile_context("s1", "a1", "hello", "aggressive", 16000)
    opt = out["optimization"]
    assert opt["mode"] == "aggressive"
    assert opt["requested_mode"] == "aggressive"
    assert "mode_warning" not in opt
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING and "mode" in r.message.lower()]
