"""M11 follow-up — OpenTelemetry bootstrap for cf context-api.

Sends spans to OTEL_EXPORTER_OTLP_ENDPOINT via OTLP HTTP. Auto-instruments
FastAPI (incoming requests) and httpx (outbound calls to IAM/MCP/composer).
SQLite instrumentation remains loaded only for standalone legacy fallback
runs; the default compose stack stores Context Fabric data in Postgres.

Trace propagation is automatic — incoming `traceparent` header from
workgraph's outbound httpx call to /execute joins the trace, so a single
trace in Jaeger shows BOTH workgraph spans and cf spans under one tree.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI

log = logging.getLogger(__name__)


def setup_otel(app: FastAPI, service_name: str = "context-api") -> None:
    if os.environ.get("OTEL_DISABLED"):
        log.info("[otel] OTEL_DISABLED set; tracing disabled")
        return
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.sqlite3 import SQLite3Instrumentor
    except ImportError as exc:
        log.warning("[otel] dependencies not installed: %s", exc)
        return

    # Opt-in: only export when a collector endpoint is EXPLICITLY configured.
    # Previously this defaulted to host.docker.internal:4318 even when no
    # collector was running (the common dev case), so every BatchSpanProcessor
    # flush failed and flooded context-api's logs with connection-refused
    # tracebacks (drowning real errors). With no endpoint set we skip tracing
    # setup entirely — no exporter, no instrumentation, no spam. Set
    # OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://otel-collector:4318) to enable.
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        log.info("[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing export disabled")
        return

    resource = Resource.create({
        "service.name":           os.environ.get("OTEL_SERVICE_NAME", service_name),
        "service.version":        "0.1.0",
        "service.namespace":      "singularity",
        "deployment.environment": os.environ.get("ENVIRONMENT", "development"),
    })
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
        endpoint=f"{endpoint.rstrip('/')}/v1/traces",
    )))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()
    SQLite3Instrumentor().instrument()
    log.info("[otel] tracer started → %s/v1/traces", endpoint)
