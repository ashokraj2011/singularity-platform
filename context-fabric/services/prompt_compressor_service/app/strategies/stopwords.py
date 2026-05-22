"""M62 Slice F — Stopword-removal compression strategy (the default).

Lossy but trivial: collapses whitespace, drops common English filler
words. Operates in microseconds with zero ML dependencies.

Quality tradeoff vs LLMLingua-2:
  - Stopwords:   ~40-60% reduction on prose, ~0% on code/JSON, no
                 awareness of token importance. Drops connective tissue
                 ("the", "of", "is") that LLMs read past anyway.
  - LLMLingua-2: ~70-80% reduction using model-derived token importance,
                 respects target_token, preserves named entities. But
                 ~600MB resident + 100-500ms per call + a 30+ minute
                 first image build.

For the platform's CODE_AGENT_RULES + RUNTIME_EVIDENCE layers — which
are typically prose authored for humans — stopword removal delivers
meaningful reduction at effectively zero cost. The output stays
readable, which is a debugging win that LLMLingua loses (its compressed
text reads as keyword soup).

The contract with the endpoint:
  - target_token / rate are ADVISORY. Stopwords removal is deterministic;
    we report the actual count back and the caller decides whether to
    re-call with a more aggressive strategy.
  - force_tokens is respected — any substring in the list survives the
    drop pass (matched case-sensitively on whole words).
  - instruction / question are passed through verbatim and prepended /
    appended to the compressed body, mirroring LLMLingua semantics.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

# Standard English stopword list — same set the user proposed. Lowercase;
# matching is case-insensitive on the original token. Kept as a module
# constant so the set lookup is constant-time per word.
FILLER_WORDS: frozenset[str] = frozenset({
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
    "between", "both", "but", "by", "could", "did", "do", "does", "doing", "down",
    "during", "each", "few", "for", "from", "further", "had", "has", "have", "having",
    "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if",
    "in", "into", "is", "it", "its", "itself", "me", "more", "most", "my", "myself",
    "nor", "of", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves",
    "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
    "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they",
    "this", "those", "through", "to", "too", "under", "until", "up", "very", "was",
    "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
    "with", "would", "you", "your", "yours", "yourself", "yourselves",
})


_WHITESPACE_RE = re.compile(r"\s+")


def compress_text(
    text: str,
    *,
    force_tokens: Optional[Iterable[str]] = None,
) -> str:
    """Drop common English filler words.

    1. Collapse runs of whitespace (newlines, tabs, multiple spaces)
       into a single space — input is treated as flat prose.
    2. Tokenize on whitespace.
    3. Drop tokens whose lowercase form is in FILLER_WORDS, EXCEPT
       when the original token appears in force_tokens (case-sensitive
       whole-word match).

    Returns the joined survivors. Empty input → empty output.
    """
    if not text:
        return ""
    forced = set(force_tokens or [])
    flat = _WHITESPACE_RE.sub(" ", text).strip()
    if not flat:
        return ""
    words = flat.split(" ")
    survivors = [
        w for w in words
        if w in forced or w.lower() not in FILLER_WORDS
    ]
    return " ".join(survivors)


def count_tokens(text: str) -> int:
    """Rough token estimate — same ~4 chars/token heuristic the rest
    of the platform uses (prompt-composer, mcp-server). Within 10-15%
    of tiktoken for English prose, good enough for the "compressed by
    how much" telemetry on the response.
    """
    return max(1, len(text) // 4) if text else 0
