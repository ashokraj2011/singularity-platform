"""M11 follow-up — OpenTelemetry bootstrap for cf context-api.

Sends spans to OTEL_EXPORTER_OTLP_ENDPOINT via OTLP HTTP. Auto-instruments
FastAPI (incoming requests), httpx (outbound calls to IAM/MCP/composer),
and sqlite3 (call_log + events_store reads/writes).

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

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://host.docker.internal:4318")
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
