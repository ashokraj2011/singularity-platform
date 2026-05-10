"""M11.e — IAM-side event bus (Postgres LISTEN/NOTIFY + outbox + subscribers).

Mirrors the design used by workgraph-api so subscribers see the same canonical
envelope shape regardless of source service.
"""
from .publisher import publish_event, EVENT_CHANNEL
from .dispatcher import start_dispatcher, stop_dispatcher

__all__ = ["publish_event", "EVENT_CHANNEL", "start_dispatcher", "stop_dispatcher"]
