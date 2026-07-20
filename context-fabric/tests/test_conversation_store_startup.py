"""
Contract: the conversation store's tables get created at startup.

This exists because they did not. `conversation_store.py` shipped with a working,
tested `init_db()`; the summariser and budget layers imported the module; and its
own docstring said the function ran "at startup alongside the other stores".
Nothing called it. On a freshly provisioned database `cf_conversations` and
`cf_conversation_turns` simply were not there — confirmed by querying a live
Postgres after a full reset, where `call_log` and `events` existed and these did
not.

It stayed invisible because the feature is flag-gated off, so no code path had
yet read a table that was not there. The first thing `CF_CONVERSATION_ENABLED=true`
would have done in production is fail on a missing relation.

The unit tests for the store all passed throughout, because they call `init_db()`
themselves in a fixture. That is the gap these assertions close: they pin the
CALL SITE, not the function. A test that exercises `init_db()` directly can never
notice that startup forgot to.
"""
from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "services" / "context_api_service" / "app"
EXECUTE = (APP / "execute.py").read_text()


def _startup_body() -> str:
    """The body of the FastAPI startup handler, bounded at the next top-level def.

    Start AFTER the handler's own `def` line: bounding from the decorator matches
    that very `def` as the terminator and yields a one-line body that contains
    nothing. (It did, on the first draft — these assertions failed against a
    correct fix.)
    """
    start = EXECUTE.index('@router.on_event("startup")')
    body_start = EXECUTE.index("\n", EXECUTE.index("def ", start)) + 1
    rest = EXECUTE[body_start:]
    # Stop at the next module-level construct so a neighbouring function's calls
    # cannot satisfy an assertion about this one.
    end = re.search(r"\n(?:@router\.|def |class |# ─)", rest)
    return rest[: end.start()] if end else rest


def test_startup_initialises_the_conversation_store():
    assert "conversation_store.init_db()" in _startup_body()


def test_conversation_store_is_imported():
    # Wiring the call without the import is an ImportError at boot, i.e. the
    # whole service fails to start rather than one store quietly missing.
    assert re.search(r"^from \. import .*\bconversation_store\b", EXECUTE, re.M)


def test_every_store_with_an_init_db_is_initialised_at_startup():
    """The generalisation — this is the assertion that would have caught it.

    Any module in app/ exposing a module-level `init_db()` is a store that owns
    its own schema, and a store whose schema is never created is a latent
    missing-relation error. Rather than listing today's three stores, discover
    them, so store number four is covered on the day it is written.
    """
    body = _startup_body()
    missing = []
    for module in sorted(APP.glob("*.py")):
        if module.name == "execute.py":
            continue
        if not re.search(r"^def init_db\(", module.read_text(), re.M):
            continue
        if f"{module.stem}.init_db()" not in body:
            missing.append(module.stem)
    assert not missing, f"stores with init_db() never called at startup: {missing}"


def test_init_db_is_idempotent_in_shape():
    # It runs on every boot, so a non-repeatable statement is a crash loop, not
    # a one-time error.
    src = (APP / "conversation_store.py").read_text()
    creates = re.findall(r"CREATE (?:UNIQUE )?(?:TABLE|INDEX)[^(]*", src)
    assert creates, "expected CREATE statements in init_db"
    for stmt in creates:
        assert "IF NOT EXISTS" in stmt, stmt.strip()
