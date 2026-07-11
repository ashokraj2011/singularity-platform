#!/usr/bin/env python3
"""Tail bare-metal service logs into the audit-governance observability lake."""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = Path(os.environ.get("SINGULARITY_LOG_DIR", ROOT / "logs")).resolve()
STATE_FILE = Path(os.environ.get("LOG_FORWARDER_STATE_FILE", ROOT / ".singularity" / "log-forwarder-state.json")).resolve()
AUDIT_GOV_URL = os.environ.get("AUDIT_GOV_URL", "http://localhost:8500").rstrip("/")
AUDIT_GOV_TOKEN = os.environ.get("AUDIT_GOV_SERVICE_TOKEN", "").strip()
POLL_SECONDS = max(0.5, min(60.0, float(os.environ.get("LOG_FORWARDER_POLL_SEC", "2"))))
MAX_BATCH = max(1, min(500, int(os.environ.get("LOG_FORWARDER_MAX_BATCH", "200"))))
MAX_LINE_BYTES = max(1024, min(64 * 1024, int(os.environ.get("LOG_FORWARDER_MAX_LINE_BYTES", "16384"))))
BOOTSTRAP_BYTES = max(0, min(10 * 1024 * 1024, int(os.environ.get("LOG_FORWARDER_BOOTSTRAP_BYTES", "262144"))))
ENVIRONMENT = os.environ.get("SINGULARITY_ENVIRONMENT", os.environ.get("SINGULARITY_ENV", os.environ.get("NODE_ENV", "local")))
HOST = socket.gethostname()
DEFAULT_EXCLUDES = {"audit-gov.log", "log-forwarder.log"}
EXCLUDES = DEFAULT_EXCLUDES | {item.strip() for item in os.environ.get("LOG_FORWARDER_EXCLUDE", "").split(",") if item.strip()}

SECRET_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I),
    re.compile(r"\b(?:ghp|github_pat|glpat|sk-ant|sk-proj|sk)[A-Za-z0-9_:-]{12,}"),
    re.compile(r"\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)(['\"]?)[^\s'\",}]+", re.I),
]
TRACE_RE = re.compile(r"(?:x-singularity-trace-id|trace_id|traceId)[\"']?\s*(?:=|:|\s)\s*[\"']?([A-Za-z0-9._:/-]{3,300})", re.I)
RUN_RE = re.compile(r"(?:workflow_instance_id|workflowInstanceId|run_id|runId)[\"']?\s*(?:=|:|\s)\s*[\"']?([A-Za-z0-9._:/-]{3,300})", re.I)


def redact(value: str) -> str:
    value = SECRET_PATTERNS[0].sub("Bearer [REDACTED]", value)
    value = SECRET_PATTERNS[1].sub("[REDACTED_TOKEN]", value)
    return SECRET_PATTERNS[2].sub(lambda match: f"{match.group(1)}{match.group(2)}{match.group(3)}[REDACTED]", value)


def load_state() -> dict[str, dict[str, int]]:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict[str, dict[str, int]]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_FILE)


def first_string(records: list[dict[str, Any]], *keys: str) -> str | None:
    for record in records:
        for key in keys:
            value = record.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def level_for(value: Any, line: str) -> str:
    if isinstance(value, int):
        return "fatal" if value >= 60 else "error" if value >= 50 else "warn" if value >= 40 else "info" if value >= 30 else "debug" if value >= 20 else "trace"
    text = f"{value or ''} {line}".lower()
    if re.search(r"\bfatal\b|\bcritical\b", text): return "fatal"
    if re.search(r"\berror\b|\bexception\b|\btraceback\b|\bfailed\b", text): return "error"
    if re.search(r"\bwarn(?:ing)?\b|\bdegraded\b|\bretry\b", text): return "warn"
    if re.search(r"\bdebug\b", text): return "debug"
    if re.search(r"\btrace\b", text): return "trace"
    return "info"


def iso_timestamp(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", text):
        return text if text.endswith("Z") or re.search(r"[+-]\d{2}:?\d{2}$", text) else f"{text}Z"
    return None


def parse_line(filename: str, raw: bytes) -> dict[str, Any] | None:
    line = redact(raw.decode("utf-8", "replace").strip())
    if not line:
        return None
    parsed: dict[str, Any] = {}
    try:
        value = json.loads(line)
        if isinstance(value, dict):
            parsed = value
    except ValueError:
        pass
    records = [parsed]
    for key in ("context", "correlation", "runContext", "run_context", "payload"):
        value = parsed.get(key)
        if isinstance(value, dict):
            records.append(value)
    message = first_string(records, "msg", "message", "error", "err") or line
    trace_id = first_string(records, "trace_id", "traceId", "x-singularity-trace-id")
    workflow_instance_id = first_string(records, "workflow_instance_id", "workflowInstanceId", "run_id", "runId")
    if not trace_id:
        match = TRACE_RE.search(line)
        trace_id = match.group(1).rstrip("\"',;}]") if match else None
    if not workflow_instance_id:
        match = RUN_RE.search(line)
        workflow_instance_id = match.group(1).rstrip("\"',;}]") if match else None
    service = re.sub(r"\.(?:log|out|err)$", "", filename, flags=re.I).removeprefix("launch-")
    record = {
        "timestamp": iso_timestamp(first_string(records, "timestamp", "ts", "time")),
        "level": level_for(parsed.get("level"), line),
        "service": service,
        "environment": ENVIRONMENT,
        "host": HOST,
        "traceId": trace_id,
        "workflowInstanceId": workflow_instance_id,
        "workflowNodeId": first_string(records, "workflow_node_id", "workflowNodeId", "node_id", "nodeId"),
        "workItemId": first_string(records, "work_item_id", "workItemId"),
        "capabilityId": first_string(records, "capability_id", "capabilityId"),
        "agentRunId": first_string(records, "agent_run_id", "agentRunId"),
        "eventType": first_string(records, "event_type", "eventType", "kind") or "process.log",
        "message": message[:8000],
        "payload": {"sourceFile": filename},
    }
    return {key: value for key, value in record.items() if value is not None}


def post_batch(records: list[dict[str, Any]]) -> None:
    if not AUDIT_GOV_TOKEN:
        raise RuntimeError("AUDIT_GOV_SERVICE_TOKEN is required")
    parsed_url = urlparse(f"{AUDIT_GOV_URL}/api/v1/logs/batch")
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        raise RuntimeError("AUDIT_GOV_URL must be an absolute http(s) URL")
    payload = json.dumps({"logs": records}, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{AUDIT_GOV_URL}/api/v1/logs/batch",
        data=payload,
        method="POST",
        headers={"authorization": f"Bearer {AUDIT_GOV_TOKEN}", "content-type": "application/json"},
    )
    with urlopen(request, timeout=10) as response:
        if response.status not in (200, 201, 202):
            raise RuntimeError(f"log ingest returned HTTP {response.status}")


def read_batch(state: dict[str, dict[str, int]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    records: list[dict[str, Any]] = []
    proposed = {key: dict(value) for key, value in state.items()}
    if not LOG_DIR.is_dir():
        return records, proposed
    for log_file in sorted(LOG_DIR.iterdir()):
        if len(records) >= MAX_BATCH:
            break
        if not log_file.is_file() or log_file.name in EXCLUDES or log_file.suffix.lower() not in {".log", ".out", ".err"}:
            continue
        stat = log_file.stat()
        key = str(log_file)
        saved = state.get(key)
        reset = not saved or saved.get("inode") != stat.st_ino or saved.get("offset", 0) > stat.st_size
        if reset:
            offset = max(0, stat.st_size - BOOTSTRAP_BYTES)
        else:
            offset = max(0, saved.get("offset", 0))
        with log_file.open("rb") as handle:
            handle.seek(offset)
            if offset > 0 and reset:
                handle.readline(MAX_LINE_BYTES)
            committed = handle.tell()
            while len(records) < MAX_BATCH:
                start = handle.tell()
                raw = handle.readline(MAX_LINE_BYTES + 1)
                if not raw:
                    break
                if not raw.endswith(b"\n") and handle.tell() >= stat.st_size and len(raw) <= MAX_LINE_BYTES:
                    handle.seek(start)
                    break
                if len(raw) > MAX_LINE_BYTES and not raw.endswith(b"\n"):
                    # Consume the remainder of an oversized physical line so
                    # the next read starts at a real record boundary. Keep a
                    # bounded prefix for diagnostics and mark it truncated.
                    while True:
                        remainder = handle.readline(MAX_LINE_BYTES + 1)
                        if not remainder or remainder.endswith(b"\n"):
                            break
                    raw = raw[:MAX_LINE_BYTES] + b" [line truncated]\n"
                committed = handle.tell()
                record = parse_line(log_file.name, raw)
                if record:
                    records.append(record)
            proposed[key] = {"inode": stat.st_ino, "offset": committed}
    return records, proposed


def run(once: bool) -> int:
    state = load_state()
    backoff = POLL_SECONDS
    while True:
        records, proposed = read_batch(state)
        if records:
            try:
                post_batch(records)
                state = proposed
                save_state(state)
                print(f"[log-forwarder] ingested {len(records)} log record(s)", flush=True)
                backoff = POLL_SECONDS
            except (HTTPError, URLError, OSError, RuntimeError) as error:
                print(f"[log-forwarder] ingest failed: {error}", file=sys.stderr, flush=True)
                if once:
                    return 1
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)
                continue
        elif proposed != state:
            state = proposed
            save_state(state)
        if once:
            return 0
        time.sleep(POLL_SECONDS)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="forward one bounded batch and exit")
    args = parser.parse_args()
    return run(args.once)


if __name__ == "__main__":
    raise SystemExit(main())
