"""M62 Slice F — Tests for the stopword strategy.

Pure-function tests against compress_text. No HTTP, no FastAPI —
fast feedback on the core compression logic. Endpoint-level dispatch
to this strategy is covered by test_compress_api.py.
"""
from __future__ import annotations

import pytest

from services.prompt_compressor_service.app.strategies.stopwords import (
    FILLER_WORDS,
    compress_text,
    count_tokens,
)


# ---- Empty / whitespace handling ---------------------------------------

def test_empty_string():
    assert compress_text("") == ""


def test_whitespace_only():
    assert compress_text("   \n\n  \t  ") == ""


# ---- The user's example: standard prose ---------------------------------

def test_basic_drop():
    """Classic example: most of these tokens are stopwords."""
    text = "You are a helpful AI assistant. Your primary goal is to help the user."
    out = compress_text(text)
    # "are", "a", "is", "to", "the" should all drop.
    assert "are" not in out.split()
    assert "is" not in out.split()
    assert "to" not in out.split()
    # Content words survive.
    assert "helpful" in out
    assert "assistant." in out
    assert "primary" in out
    assert "goal" in out


def test_case_insensitive_stopword_match():
    """The matcher lowercases, so capitalized stopwords still drop."""
    text = "The cat. THE dog. tHe bird."
    out = compress_text(text)
    # All three "the" variants gone; nouns kept.
    assert "cat." in out
    assert "dog." in out
    assert "bird." in out
    # No "the" / "THE" / "tHe" survives the drop pass.
    for word in out.split():
        assert word.lower() != "the"


# ---- Whitespace collapse ------------------------------------------------

def test_collapses_whitespace():
    """Newlines, tabs, double spaces all collapse to single spaces."""
    text = "expert   engineer\n\n\nworking  on\trules"
    out = compress_text(text)
    # 'on' is a stopword but the others survive.
    assert "expert" in out
    assert "engineer" in out
    assert "working" in out
    assert "rules" in out
    # No runs of whitespace in the output.
    assert "  " not in out
    assert "\n" not in out


# ---- force_tokens -------------------------------------------------------

def test_force_tokens_overrides_drop():
    """A word in force_tokens survives even if its lowercase form is a stopword."""
    text = "the cat sat on the mat"
    out = compress_text(text, force_tokens=["the"])
    # Case-sensitive whole-word match — both lowercase "the"s should survive.
    words = out.split()
    assert words.count("the") == 2
    # "on" is still a stopword and not forced.
    assert "on" not in words


def test_force_tokens_case_sensitive():
    """force_tokens matches the original casing."""
    text = "The cat sat on the mat"
    out = compress_text(text, force_tokens=["The"])
    words = out.split()
    # "The" (capitalized) survives because it matches force_tokens.
    # "the" (lowercase) is dropped because force_tokens is case-sensitive
    # and the lowercase form is a stopword.
    assert "The" in words
    assert "the" not in words


# ---- Filler set integrity ----------------------------------------------

def test_filler_words_all_lowercase():
    """Every entry in FILLER_WORDS must be lowercase (the matcher
    lowercases the input before lookup, so uppercase entries would
    silently never match)."""
    for w in FILLER_WORDS:
        assert w == w.lower(), f"non-lowercase stopword: {w}"


def test_filler_words_reasonable_size():
    """Sanity check — too few words = ineffective compression;
    too many = aggressive false positives like dropping "is" from
    code identifiers."""
    assert 100 <= len(FILLER_WORDS) <= 200


# ---- count_tokens -------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("", 0),
    ("hi", 1),  # 2 chars // 4 = 0 → floor to 1
    ("a" * 40, 10),
    ("a" * 4000, 1000),
])
def test_count_tokens(text, expected):
    assert count_tokens(text) == expected


# ---- End-to-end compression ratio --------------------------------------

def test_typical_prose_reduces_meaningfully():
    """A realistic platform prose paragraph reduces by ~15-20%.

    Honest baseline: technical text dense with proper nouns
    (RuleEngine, ASTs, etc.) doesn't compress as aggressively as
    generic English — there's just less filler. The win comes from
    consistently shaving dozens of `the` / `is` / `to` / `a` etc.
    out of multi-KB ambient layers.

    Generic English prose (think CLAUDE.md style: "When working on
    this codebase, you should always remember that we prefer X over Y...")
    compresses 35-50%. The threshold here is the LOWER bound — even
    on stopword-poor input we want a measurable reduction.
    """
    text = (
        "You are an expert software engineer working on the RuleEngine capability. "
        "The capability provides operator-driven condition evaluation across multiple "
        "data sources. The architecture uses a Java service layer that compiles rules "
        "into ASTs and evaluates them per record."
    )
    out = compress_text(text)
    reduction = 1 - (len(out) / len(text))
    assert reduction > 0.15, f"only reduced by {reduction:.2%}"


def test_generic_prose_reduces_aggressively():
    """The high-water-mark case: when input is mostly filler (CLAUDE.md
    style instruction prose), reduction approaches 50%."""
    text = (
        "When you are working on this codebase, you should always remember "
        "that we prefer to write code that is clear over code that is clever. "
        "If you have a question about how something is supposed to be done, "
        "you should ask the team before you make any changes that could be "
        "risky to the users of the system."
    )
    out = compress_text(text)
    reduction = 1 - (len(out) / len(text))
    assert reduction > 0.40, f"only reduced by {reduction:.2%}"
