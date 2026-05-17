from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Any

from context_fabric_shared.token_counter import count_text_tokens
from .repository import (
    init_db, insert_message, get_messages, count_messages_since_summary,
    insert_summary, get_latest_summary, insert_memory_item, list_memory_items,
    get_context_package
)
from .summarizer import summarize_with_llm, summary_token_count
from .context_compiler import compile_context
from .memory_search import rank_memory_items

app = FastAPI(title="Context Fabric - Context Memory Service", version="0.1.0")


@app.on_event("startup")
def _startup():
    init_db()


@app.on_event("startup")
async def _warm_system_prompts() -> None:
    """M37.2 — Warm the SystemPrompt cache so the first /context/compile call
    hits a populated cache. Silently no-ops if composer is unreachable."""
    try:
        from .context_compiler import warm_default_system_prompt
        await warm_default_system_prompt()
    except Exception as err:
        import logging
        logging.getLogger(__name__).warning("[startup] system-prompt warm failed: %s", err)


@app.on_event("startup")
async def _register_with_platform() -> None:
    import os as _os
    from .platform_registry import start_self_registration
    await start_self_registration({
        "service_name":  "context-memory",
        "display_name":  "Context Fabric Memory",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8002"),
        "health_path":   "/health",
        "auth_mode":     "none",
        "owner_team":    "context-fabric",
        "metadata":      {"layer": "optimization"},
        "capabilities": [
            {"capability_key": "memory.messages",   "description": "Conversation message history"},
            {"capability_key": "memory.summaries",  "description": "Rolling conversation summaries"},
            {"capability_key": "memory.search",     "description": "Distilled-knowledge semantic search"},
            {"capability_key": "context.compile",   "description": "Compile optimized context package for LLM call"},
        ],
    })


@app.get("/health")
def health():
    return {"status": "ok", "service": "context-memory-service"}


class MessageRequest(BaseModel):
    session_id: str
    agent_id: str | None = None
    role: str
    content: str


@app.post("/memory/messages")
def save_message(req: MessageRequest):
    mid = insert_message(req.session_id, req.agent_id, req.role, req.content, count_text_tokens(req.content))
    return {"id": mid, "status": "saved"}


@app.get("/memory/messages/{session_id}")
def read_messages(session_id: str, limit: int | None = None):
    return {"messages": get_messages(session_id, limit=limit, ascending=True)}


@app.get("/memory/messages/{session_id}/stats")
def message_stats(session_id: str):
    messages = get_messages(session_id, ascending=True)
    return {
        "session_id": session_id,
        "message_count": len(messages),
        "messages_since_summary": count_messages_since_summary(session_id),
        "total_tokens": sum(int(m.get("token_count") or 0) for m in messages),
    }


class SummaryUpdateRequest(BaseModel):
    session_id: str
    agent_id: str | None = None
    force: bool = False
    min_messages_since_last_summary: int = 8


@app.post("/memory/summaries/update")
async def update_summary(req: SummaryUpdateRequest):
    since = count_messages_since_summary(req.session_id)
    if not req.force and since < req.min_messages_since_last_summary:
        latest = get_latest_summary(req.session_id)
        return {"updated": False, "reason": "threshold_not_met", "messages_since_summary": since, "latest_summary": latest}
    messages = get_messages(req.session_id, ascending=True)
    if not messages:
        raise HTTPException(status_code=400, detail="No messages to summarize")
    summary = await summarize_with_llm(messages, agent_id=req.agent_id)
    sid = insert_summary(req.session_id, req.agent_id, "rolling", summary, summary_token_count(summary))
    for item in summary.get("durable_learning", [])[:10]:
        insert_memory_item({
            "session_id": req.session_id,
            "agent_id": req.agent_id,
            "memory_type": "durable_learning",
            "content": item,
            "importance_score": 0.75,
            "confidence": 0.75,
            "source_type": "summary",
            "source_id": sid,
        })
    return {"updated": True, "summary_id": sid, "summary": summary, "tokens": summary_token_count(summary)}


@app.get("/memory/summaries/latest/{session_id}")
def latest_summary(session_id: str):
    return {"summary": get_latest_summary(session_id)}


class MemoryItemRequest(BaseModel):
    session_id: str | None = None
    agent_id: str | None = None
    project_id: str | None = None
    memory_type: str
    content: str
    importance_score: float = 0.5
    confidence: float = 0.8
    source_type: str | None = None
    source_id: str | None = None


@app.post("/memory/items")
def save_memory_item(req: MemoryItemRequest):
    mid = insert_memory_item(req.model_dump())
    return {"id": mid, "status": "saved"}


class MemorySearchRequest(BaseModel):
    query: str
    agent_id: str | None = None
    session_id: str | None = None
    limit: int = 5


@app.post("/memory/search")
def search_memory(req: MemorySearchRequest):
    items = []
    if req.agent_id:
        items += list_memory_items(agent_id=req.agent_id, limit=200)
    if req.session_id:
        items += list_memory_items(session_id=req.session_id, limit=200)
    if not req.agent_id and not req.session_id:
        items = list_memory_items(limit=200)
    return {"items": rank_memory_items(req.query, items, req.limit)}


class CompileRequest(BaseModel):
    session_id: str
    agent_id: str | None = None
    user_message: str
    optimization_mode: str = "medium"
    compare_with_raw: bool = True
    max_context_tokens: int = 16000
    provider: str = "mock"
    model: str = "mock-fast"
    system_prompt: str | None = None


@app.post("/context/compile")
def compile(req: CompileRequest):
    mode = req.optimization_mode
    if mode == "auto":
        stats = get_messages(req.session_id, ascending=True)
        total = sum(count_text_tokens(m["content"], req.model) for m in stats)
        mode = "aggressive" if total > 50000 else "medium"
    return compile_context(
        session_id=req.session_id,
        agent_id=req.agent_id,
        user_message=req.user_message,
        mode=mode,
        max_context_tokens=req.max_context_tokens,
        provider=req.provider,
        model=req.model,
        system_prompt=req.system_prompt,
    )


class CompareRequest(BaseModel):
    session_id: str
    agent_id: str | None = None
    message: str
    modes: list[str] = Field(default_factory=lambda: ["none", "conservative", "medium", "aggressive"])
    max_context_tokens: int = 16000
    provider: str = "mock"
    model: str = "mock-fast"


@app.post("/context/compare")
def compare(req: CompareRequest):
    comparisons = []
    best = None
    for mode in req.modes:
        result = compile_context(req.session_id, req.agent_id, req.message, mode, req.max_context_tokens, req.provider, req.model)
        opt = result["optimization"]
        comparisons.append(opt)
        if mode != "none" and (best is None or opt["percent_saved"] > best["percent_saved"]):
            best = opt
    recommended = "medium"
    if best and best["percent_saved"] > 85:
        recommended = "aggressive"
    elif best and best["percent_saved"] > 60:
        recommended = "medium"
    elif best:
        recommended = "conservative"
    return {"comparisons": comparisons, "recommended_mode": recommended}


@app.get("/context/packages/{context_package_id}")
def read_context_package(context_package_id: str):
    ctx = get_context_package(context_package_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="context package not found")
    return ctx
