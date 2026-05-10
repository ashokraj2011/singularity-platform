from __future__ import annotations

import re


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z0-9_]{3,}", text.lower()))


def rank_memory_items(query: str, items: list[dict], limit: int = 5) -> list[dict]:
    q = tokenize(query)
    scored = []
    seen = set()
    for item in items:
        item_id = item.get("id")
        if item_id in seen:
            continue
        seen.add(item_id)
        content = item.get("content", "")
        words = tokenize(content)
        overlap = len(q.intersection(words))
        importance = float(item.get("importance_score") or 0.5)
        confidence = float(item.get("confidence") or 0.8)
        score = overlap * 2.0 + importance + confidence
        if overlap > 0 or not q:
            d = dict(item)
            d["relevance_score"] = round(score, 4)
            scored.append(d)
    scored.sort(key=lambda x: x["relevance_score"], reverse=True)
    return scored[:limit]
