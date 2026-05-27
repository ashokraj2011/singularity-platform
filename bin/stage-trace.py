#!/usr/bin/env python3
"""
stage-trace.py — operator tool to trace a governed-loop stage attempt
(M89, 2026-05-27).

Reads two sources and merges them into one chronological timeline so you
can see exactly what happened in a failed (or successful) stage attempt
without grepping through OTEL-flooded container logs:

  1. wg-postgres `blueprint_stage_runs` row — the attempt outcome
     (stopReason, finalPhase, totalTurns, verification receipts,
     error message).
  2. audit-gov `/api/v1/audit/search?traceId=blueprint-<session>-<stage>`
     events — per-turn LLM responses, tool dispatches, refusals,
     phase transitions, validation errors, budget warnings.

Usage:
    bin/stage-trace.py --attempt-id 19a55e93-fcd9-4ec5-abc4-88a5b67b7259
    bin/stage-trace.py --session-id de31171d-... --stage develop
    bin/stage-trace.py --session-id de31171d-... --stage develop --attempts 3
    bin/stage-trace.py --session-id de31171d-... --stage develop --verbose

Defaults: shows the latest attempt for the given (session, stage). With
--attempts N, walks back N attempts. Verbose mode dumps every LLM
response with content excerpts and tool args.

Environment / connections:
  - wg-postgres connection: assumes localhost:5434 with default
    workgraph/workgraph_secret creds. Override with WG_POSTGRES_URL.
  - audit-gov: defaults to http://localhost:8500. Override with
    AUDIT_GOV_URL.

Exit code 0 if at least one attempt was rendered; 1 on lookup failure.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

# ── Color helpers ─────────────────────────────────────────────────────────

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _c(code: str, text: str) -> str:
    if not _USE_COLOR:
        return text
    return f"\033[{code}m{text}\033[0m"


GREEN = lambda s: _c("32", s)
RED = lambda s: _c("31", s)
YELLOW = lambda s: _c("33", s)
BLUE = lambda s: _c("34", s)
DIM = lambda s: _c("2", s)
BOLD = lambda s: _c("1", s)
CYAN = lambda s: _c("36", s)


# ── Data sources ──────────────────────────────────────────────────────────


def query_wg_postgres(sql: str) -> list[dict[str, Any]]:
    """Run a SELECT against wg-postgres via `docker compose exec`. Returns
    list of row dicts. Bypasses needing psycopg2 installed on the host."""
    import subprocess

    # We use `-A` (unaligned) + `-t` (tuples only) + custom separator so we
    # can split unambiguously even when values contain spaces or commas.
    cmd = [
        "docker", "compose", "exec", "-T", "wg-postgres",
        "psql", "-U", "workgraph", "-d", "workgraph",
        "-A", "-t", "-F", "",  # ASCII unit separator
        "-c", sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        sys.stderr.write(f"psql failed: {proc.stderr}\n")
        return []
    # Extract column names from the SQL — psql -t suppresses headers. We
    # parse them out by re-running with headers to get the order. Cheaper
    # path: assume caller knows the column order and zip.
    return [line.split("") for line in proc.stdout.strip().splitlines() if line]


def fetch_attempt(attempt_id: str) -> dict[str, Any] | None:
    """Look up a single attempt row by id."""
    sql = (
        "SELECT id, \"sessionId\", stage, status, "
        "\"createdAt\", \"completedAt\", coalesce(error, ''), "
        "coalesce(correlation::text, '{}') "
        f"FROM blueprint_stage_runs WHERE id = '{attempt_id}' LIMIT 1;"
    )
    rows = query_wg_postgres(sql)
    if not rows:
        return None
    r = rows[0]
    return {
        "id": r[0],
        "sessionId": r[1],
        "stage": r[2],
        "status": r[3],
        "createdAt": r[4],
        "completedAt": r[5],
        "error": r[6],
        "correlation": _safe_json(r[7]),
    }


def fetch_attempts_for_stage(
    session_id: str, stage: str, limit: int
) -> list[dict[str, Any]]:
    """Get the last N attempts for (session_id, stage). `stage` is the
    enum value the DB uses (DEVELOPER / ARCHITECT / QA / etc), but we
    accept lower-case aliases too."""
    # Map user-friendly stage names to DB enum.
    alias = {"develop": "DEVELOPER", "design": "ARCHITECT", "qa": "QA"}
    db_stage = alias.get(stage.lower(), stage.upper())
    sql = (
        "SELECT id, \"sessionId\", stage, status, "
        "\"createdAt\", \"completedAt\", coalesce(error, ''), "
        "coalesce(correlation::text, '{}') "
        f"FROM blueprint_stage_runs "
        f"WHERE \"sessionId\" = '{session_id}' AND stage = '{db_stage}' "
        f"ORDER BY \"createdAt\" DESC LIMIT {int(limit)};"
    )
    rows = query_wg_postgres(sql)
    out = []
    for r in rows:
        out.append({
            "id": r[0],
            "sessionId": r[1],
            "stage": r[2],
            "status": r[3],
            "createdAt": r[4],
            "completedAt": r[5],
            "error": r[6],
            "correlation": _safe_json(r[7]),
        })
    return out


def _safe_json(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw) if raw and raw.strip() else {}
    except Exception:
        return {}


def fetch_audit_events(
    trace_id: str, since_iso: str | None = None, limit: int = 1500
) -> list[dict[str, Any]]:
    """Pull audit-gov events for a trace. Returns sorted ascending.

    audit-gov enforces a per-call page limit of 500, so we paginate via
    the `nextCursor` field until we hit `limit` or run out."""
    base = os.environ.get("AUDIT_GOV_URL", "http://localhost:8500")
    url = f"{base.rstrip('/')}/api/v1/audit/search"

    all_events: list[dict[str, Any]] = []
    cursor: str | None = None
    page_size = 500
    while len(all_events) < limit:
        body: dict[str, Any] = {
            "sourceService": "context-fabric",
            "traceId": trace_id,
            "limit": min(page_size, limit - len(all_events)),
        }
        if cursor:
            body["cursor"] = cursor
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
        except Exception as exc:
            sys.stderr.write(f"audit-gov fetch failed: {exc}\n")
            break
        events = data.get("items") or data.get("events") or []
        all_events.extend(events)
        cursor = data.get("nextCursor") or data.get("cursor")
        if not cursor or not events:
            break

    if since_iso:
        all_events = [e for e in all_events if (e.get("created_at") or "") >= since_iso]
    all_events.sort(key=lambda e: e.get("created_at") or "")
    return all_events


# ── Rendering ─────────────────────────────────────────────────────────────

# Audit kinds we choose to fold into a single line each.
_NOISY_KINDS = {
    "governed.llm_request",   # paired with llm_response, drop the bare request
    "governed.pii_masked",    # routine, only show if verbose
}


def render_attempt(attempt: dict[str, Any], *, verbose: bool = False) -> None:
    corr = attempt.get("correlation") or {}
    gov = corr.get("governed") or {}
    coding = corr.get("codingAgent") or {}
    stop = gov.get("stopReason") or "(unknown)"
    final = gov.get("finalPhase") or "(unknown)"
    turns = gov.get("totalTurns") or 0
    err = attempt.get("error") or ""
    status = attempt.get("status") or "?"
    status_color = GREEN if status == "COMPLETED" else (RED if status == "FAILED" else YELLOW)

    print()
    print(BOLD(f"━━━ attempt {attempt['id']} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"))
    print(f"  stage:      {attempt.get('stage')}")
    print(f"  status:     {status_color(status)}")
    print(f"  created:    {attempt.get('createdAt')}")
    print(f"  completed:  {attempt.get('completedAt') or '(none)'}")
    if err:
        print(f"  error:      {RED(err[:300])}")
    print(f"  stopReason: {YELLOW(stop) if stop != 'FINALIZED' else GREEN(stop)}")
    print(f"  finalPhase: {final}")
    print(f"  totalTurns: {turns}")
    code_changes = corr.get("codeChangeIds") or coding.get("codeChangeIds") or []
    print(f"  codeChangeIds: {len(code_changes)}")
    receipts = coding.get("verificationReceipts") or corr.get("verificationReceipts") or []
    if receipts:
        print(f"  verificationReceipts ({len(receipts)}):")
        for r in receipts:
            ok = bool(r.get("passed"))
            mark = GREEN("✓") if ok else RED("✗")
            cmd = r.get("command") or "?"
            xc = r.get("exitCode")
            src = r.get("source") or "?"
            print(f"    {mark} [{src}] {cmd} exit={xc}")

    # ── Per-turn timeline from audit-gov ──
    # traceId is shared across all attempts for the same (session, stage),
    # so we MUST clip by the attempt's createdAt..completedAt window or
    # we'll mix turns from prior attempts.
    trace_id = f"blueprint-{attempt['sessionId']}-{_stage_to_kebab(attempt['stage'])}"
    start_iso = _to_audit_iso(attempt.get("createdAt"))
    end_iso = _to_audit_iso(attempt.get("completedAt")) if attempt.get("completedAt") else None
    events = fetch_audit_events(trace_id, since_iso=start_iso)
    if end_iso:
        # Add a 1s grace window — final receipts/events sometimes land
        # right after the attempt row gets its completedAt stamped.
        end_with_grace = end_iso[:-1] + "1Z" if end_iso.endswith("Z") else end_iso
        events = [e for e in events if (e.get("created_at") or "") <= end_with_grace]
    # Belt-and-suspenders: drop anything older than start_iso even if the
    # API didn't honor since (in case audit-gov ignores since_iso).
    if start_iso:
        events = [e for e in events if (e.get("created_at") or "") >= start_iso]

    if not events:
        print(DIM("\n  (no audit events found for this trace)"))
        return

    print()
    print(BOLD("  ── timeline ──"))
    turn_idx = 0
    last_phase = None
    for e in events:
        kind = e.get("kind") or ""
        if kind in _NOISY_KINDS and not verbose:
            continue
        payload = e.get("payload") or {}
        gov_p = payload.get("governance") or {}
        phase = gov_p.get("current_phase") or "?"
        ts = (e.get("created_at") or "")[-13:-1]  # HH:MM:SS.sss

        # Phase header on transition
        if phase != last_phase:
            print()
            print(DIM(f"  ┌─ {phase} ─" + "─" * (60 - len(phase))))
            last_phase = phase

        if kind == "governed.llm_response":
            turn_idx += 1
            tools = payload.get("tool_calls") or []
            names = [t.get("name") for t in tools]
            content = (payload.get("content") or "").strip()
            latency = payload.get("latency_ms")
            lat_s = f" {latency}ms" if latency else ""
            tool_s = f"tools={names}" if names else "tools=[]"
            line = f"  {DIM(ts)} {CYAN(f'turn {turn_idx:2d}'):>8s}  {tool_s}{DIM(lat_s)}"
            print(line)
            if verbose and content:
                first = content.splitlines()[0][:120]
                print(f"           {DIM('content:')} {first}")
        elif kind == "governed.tool_dispatched":
            if verbose:
                tn = payload.get("tool_name") or "?"
                dur = payload.get("duration_ms")
                ok = payload.get("ok")
                mark = GREEN("✓") if ok else RED("✗")
                print(f"  {DIM(ts)} {'':>8s}    {mark} dispatch {tn} {DIM(f'{dur}ms') if dur else ''}")
        elif kind == "governed.tool_refused":
            tn = payload.get("tool_name") or "?"
            reason = (payload.get("reason") or "")[:100]
            print(f"  {DIM(ts)} {'':>8s}    {RED('✗ refused')} {tn}  {DIM(reason)}")
        elif kind == "governed.phase_completed":
            print(f"  {DIM(ts)} {'':>8s}    {GREEN('✓ phase_completed')}")
        elif kind == "governed.phase_output_invalid":
            reason = payload.get("reason") or "?"
            details = payload.get("details") or []
            fields = [d.get("field") for d in details if isinstance(d, dict)]
            missing = ",".join(f for f in fields if f) or "?"
            print(f"  {DIM(ts)} {'':>8s}    {RED('✗ phase_output_invalid')} {DIM(reason)} missing=[{missing}]")
        elif kind == "governed.phase_budget_exceeded":
            budget = payload.get("budget")
            tinp = payload.get("turns_in_phase")
            print(f"  {DIM(ts)} {'':>8s}    {YELLOW(f'⚠ phase_budget_exceeded {tinp}/{budget}')}")
        elif kind == "governed.path_coverage_gap":
            uncov = payload.get("uncovered") or payload.get("uncovered_files") or []
            print(f"  {DIM(ts)} {'':>8s}    {RED('✗ path_coverage_gap')} uncovered={len(uncov)}")
        elif kind == "governed.auto_verify_completed":
            print(f"  {DIM(ts)} {'':>8s}    {BLUE('• auto_verify_completed')}")
        elif kind == "governed.tool_dispatch_failed":
            tn = payload.get("tool_name") or "?"
            err = (payload.get("error") or "")[:120]
            print(f"  {DIM(ts)} {'':>8s}    {RED('✗ dispatch_failed')} {tn}  {DIM(err)}")
        elif kind.startswith("governed."):
            # Catch-all for any other governed.* events we haven't styled.
            print(f"  {DIM(ts)} {'':>8s}    • {kind} {DIM(json.dumps({k:v for k,v in payload.items() if k!='governance'})[:120])}")
        else:
            if verbose:
                print(f"  {DIM(ts)} {'':>8s}    · {kind}")

    # Per-phase summary
    print()
    phase_counts: dict[str, int] = {}
    for e in events:
        if e.get("kind") == "governed.llm_response":
            gov_p = (e.get("payload") or {}).get("governance") or {}
            p = gov_p.get("current_phase") or "?"
            phase_counts[p] = phase_counts.get(p, 0) + 1
    if phase_counts:
        print(BOLD("  ── per-phase LLM turns ──"))
        for p, c in phase_counts.items():
            print(f"    {p:<14s} {c}")


def _stage_to_kebab(stage: str) -> str:
    """Map DB enum (DEVELOPER) → trace-id segment (develop)."""
    rev = {"DEVELOPER": "develop", "ARCHITECT": "design", "QA": "qa", "PRODUCT_OWNER": "intake"}
    return rev.get(stage, stage.lower())


def _to_iso(maybe_ts: str) -> str:
    """psql often returns timestamps like '2026-05-27 06:17:18.361'. The
    audit events use ISO with T and Z. Convert so string compare works."""
    s = (maybe_ts or "").strip()
    if "T" in s:
        return s
    return s.replace(" ", "T")


def _to_audit_iso(pg_ts: str | None) -> str | None:
    """Normalise a postgres timestamp to the exact shape audit-gov emits:
    `YYYY-MM-DDTHH:MM:SS.sssZ`. Without the Z and milliseconds the
    string-compare against audit events drifts at second boundaries."""
    if not pg_ts:
        return None
    s = pg_ts.strip().replace(" ", "T")
    # Pad fractional seconds to exactly 3 digits.
    if "." in s:
        head, frac = s.split(".", 1)
        # Strip any trailing Z so we can re-add it after padding.
        frac = frac.rstrip("Z")
        frac = (frac + "000")[:3]
        s = f"{head}.{frac}"
    else:
        s = f"{s}.000"
    if not s.endswith("Z"):
        s = f"{s}Z"
    return s


# ── Entry point ───────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="Trace a governed-loop stage attempt")
    ap.add_argument("--attempt-id", help="Specific blueprint_stage_runs.id to render")
    ap.add_argument("--session-id", help="BlueprintSession id (with --stage)")
    ap.add_argument("--stage", help="Stage key (develop / design / qa)")
    ap.add_argument("--attempts", type=int, default=1,
                    help="When using --session-id, render the last N attempts")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="Show tool dispatch details, content excerpts, raw events")
    args = ap.parse_args()

    if args.attempt_id:
        att = fetch_attempt(args.attempt_id)
        if not att:
            sys.stderr.write(f"no attempt found with id {args.attempt_id}\n")
            return 1
        render_attempt(att, verbose=args.verbose)
        return 0

    if args.session_id and args.stage:
        attempts = fetch_attempts_for_stage(args.session_id, args.stage, args.attempts)
        if not attempts:
            sys.stderr.write(f"no attempts found for session {args.session_id} stage {args.stage}\n")
            return 1
        # Render newest first.
        for att in attempts:
            render_attempt(att, verbose=args.verbose)
        return 0

    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
