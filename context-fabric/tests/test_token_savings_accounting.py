"""P2 — honest savings accounting in compile_context.

Verifies the new additive fields are correct and that the legacy contract keys
(consumed by main.py, the metrics ledger, and the integration test) are intact.
Pure in-process (repository monkeypatched via conftest.patch_repo).
"""
from __future__ import annotations

from context_memory_service.app import context_compiler as cc
from conftest import make_rows, make_summary, make_memory_items


_LEGACY_KEYS = {"mode", "raw_input_tokens", "optimized_input_tokens", "tokens_saved", "percent_saved"}


def test_legacy_optimization_keys_preserved(patch_repo):
    patch_repo(messages=make_rows(20), summary=make_summary(["g", "ctx"]), memory=make_memory_items(5))
    out = cc.compile_context("s1", "a1", "hi", "medium", 16000)
    opt = out["optimization"]
    assert _LEGACY_KEYS.issubset(opt.keys())
    # gross savings unchanged in meaning: optimized <= raw
    assert opt["optimized_input_tokens"] <= opt["raw_input_tokens"] or opt["tokens_saved"] == 0


def test_net_savings_charges_summary_cost(patch_repo):
    # A real summary is present → summary_generation_tokens > 0 and net <= gross.
    patch_repo(
        messages=make_rows(30, content="some conversation content here"),
        summary=make_summary(["the current goal", "important context line"]),
        memory=make_memory_items(5),
    )
    opt = cc.compile_context("s1", "a1", "what next?", "medium", 16000)["optimization"]
    assert opt["summary_generation_tokens"] > 0
    assert opt["net_tokens_saved"] <= opt["tokens_saved"]
    assert opt["net_tokens_saved"] == max(0, opt["tokens_saved"] - opt["summary_generation_tokens"])
    assert "optimized_scaffolding_tokens" in opt and opt["optimized_scaffolding_tokens"] > 0


def test_mode_none_charges_no_summary_cost(patch_repo):
    patch_repo(messages=make_rows(10), summary=make_summary(["g", "c"]), memory=make_memory_items(3))
    opt = cc.compile_context("s1", "a1", "hello", "none", 16000)["optimization"]
    # "none" returns raw full context — no embedded summary, so no charge.
    assert opt["summary_generation_tokens"] == 0
    assert opt["net_tokens_saved"] == opt["tokens_saved"]


def test_no_summary_means_no_summary_cost(patch_repo):
    # medium mode but no summary exists in the store.
    patch_repo(messages=make_rows(8), summary=None, memory=make_memory_items(3))
    opt = cc.compile_context("s1", "a1", "hello", "medium", 16000)["optimization"]
    assert opt["summary_generation_tokens"] == 0
