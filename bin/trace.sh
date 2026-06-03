#!/usr/bin/env bash
# Unified LLM ↔ agent ↔ tool trace viewer.
#
# Renders a readable timeline of everything that happened in a single MCP
# agent loop run: the LLM prompt previews, the model's text/tool-call
# responses, and every tool invocation with its output summary. Sourced
# from `/workspace/.singularity/mcp-audit.jsonl` inside the
# singularity-mcp-server container.
#
# Usage:
#   ./bin/trace.sh <workflow-instance-id>            # full trace for a run
#   ./bin/trace.sh <workflow-instance-id> --stage develop
#   ./bin/trace.sh <workflow-instance-id> --tail 50  # last N events only
#   ./bin/trace.sh --latest                          # most recent run
#   ./bin/trace.sh --list                            # list known instances
#   ./bin/trace.sh <workflow-instance-id> --raw      # JSONL passthrough
#
# Filtering shortcuts:
#   --stage <key>     filter by stage in traceId (e.g. develop, plan, design)
#   --since <iso>     skip events earlier than this ISO timestamp
#   --tail N          show only the last N events
#   --tool <name>     restrict to a single tool (e.g. write_file, find_symbol)
#   --no-prompt       hide LLM prompt-message previews (smaller output)
#   --no-output       hide tool output previews (smaller output)
#   --raw             dump the matching JSONL records, no formatting
#
# The renderer is intentionally read-only; nothing is mutated in the
# container. Safe to run while a stage is in progress.

set -euo pipefail

CONTAINER="${MCP_SERVER_CONTAINER:-singularity-mcp-server}"
AUDIT_PATH="${MCP_AUDIT_PATH:-/workspace/.singularity/mcp-audit.jsonl}"

WORKFLOW_ID=""
STAGE_FILTER=""
SINCE_FILTER=""
TAIL_N=""
TOOL_FILTER=""
HIDE_PROMPT=0
HIDE_OUTPUT=0
RAW=0
LATEST=0
LIST_ONLY=0

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --latest) LATEST=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --stage) STAGE_FILTER="$2"; shift 2 ;;
    --since) SINCE_FILTER="$2"; shift 2 ;;
    --tail) TAIL_N="$2"; shift 2 ;;
    --tool) TOOL_FILTER="$2"; shift 2 ;;
    --no-prompt) HIDE_PROMPT=1; shift ;;
    --no-output) HIDE_OUTPUT=1; shift ;;
    --raw) RAW=1; shift ;;
    --*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$WORKFLOW_ID" ]; then WORKFLOW_ID="$1"; shift; else echo "extra arg: $1" >&2; exit 2; fi ;;
  esac
done

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ container '$CONTAINER' not running. Set MCP_SERVER_CONTAINER to override." >&2
  exit 1
fi

# Stream the audit log out of the container once and reuse it.
TMP_AUDIT="$(mktemp -t mcp-audit.XXXXXX.jsonl)"
trap 'rm -f "$TMP_AUDIT"' EXIT
docker cp "$CONTAINER:$AUDIT_PATH" "$TMP_AUDIT" >/dev/null 2>&1 || {
  echo "✗ failed to read $AUDIT_PATH from $CONTAINER" >&2
  exit 1
}

if [ "$LIST_ONLY" = "1" ]; then
  python3 - "$TMP_AUDIT" <<'PY'
import json, sys, collections
path = sys.argv[1]
seen = collections.OrderedDict()
with open(path, "r") as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        corr = (d.get("record") or {}).get("correlation") or {}
        wf = corr.get("workflowInstanceId")
        tr = corr.get("traceId") or ""
        if not wf:
            continue
        if wf not in seen:
            seen[wf] = {"trace": set(), "first": None, "last": None, "count": 0}
        seen[wf]["trace"].add(tr.split("-")[-1] if tr else "?")
        ts = (d.get("record") or {}).get("timestamp")
        if ts:
            seen[wf]["first"] = seen[wf]["first"] or ts
            seen[wf]["last"] = ts
        seen[wf]["count"] += 1
print(f"{'workflowInstanceId':38s}  events  stages                first → last")
for wf, info in seen.items():
    stages = ",".join(sorted(info["trace"]))
    print(f"{wf:38s}  {info['count']:>6d}  {stages:<20s}  {info['first']} → {info['last']}")
PY
  exit 0
fi

if [ "$LATEST" = "1" ]; then
  WORKFLOW_ID="$(python3 - "$TMP_AUDIT" <<'PY'
import json, sys
path = sys.argv[1]
latest = None; latest_ts = ""
with open(path, "r") as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        r = d.get("record") or {}
        ts = r.get("timestamp") or ""
        wf = (r.get("correlation") or {}).get("workflowInstanceId")
        if wf and ts > latest_ts:
            latest_ts = ts; latest = wf
print(latest or "")
PY
)"
  if [ -z "$WORKFLOW_ID" ]; then
    echo "✗ no workflow instances found in audit log" >&2
    exit 1
  fi
  echo "▸ latest workflow: $WORKFLOW_ID"
  echo
fi

if [ -z "$WORKFLOW_ID" ]; then
  echo "usage: $0 <workflow-instance-id> [flags]" >&2
  echo "       $0 --latest" >&2
  echo "       $0 --list" >&2
  exit 2
fi

if [ "$RAW" = "1" ]; then
  grep -F "\"workflowInstanceId\":\"$WORKFLOW_ID\"" "$TMP_AUDIT" || true
  exit 0
fi

export TRACE_WORKFLOW_ID="$WORKFLOW_ID"
export TRACE_STAGE_FILTER="$STAGE_FILTER"
export TRACE_SINCE_FILTER="$SINCE_FILTER"
export TRACE_TAIL_N="$TAIL_N"
export TRACE_TOOL_FILTER="$TOOL_FILTER"
export TRACE_HIDE_PROMPT="$HIDE_PROMPT"
export TRACE_HIDE_OUTPUT="$HIDE_OUTPUT"

python3 - "$TMP_AUDIT" <<'PY'
import json, os, sys, textwrap

audit_path = sys.argv[1]
WF = os.environ["TRACE_WORKFLOW_ID"]
STAGE = os.environ.get("TRACE_STAGE_FILTER") or ""
SINCE = os.environ.get("TRACE_SINCE_FILTER") or ""
TAIL = int(os.environ.get("TRACE_TAIL_N") or 0)
TOOL = os.environ.get("TRACE_TOOL_FILTER") or ""
HIDE_PROMPT = os.environ.get("TRACE_HIDE_PROMPT") == "1"
HIDE_OUTPUT = os.environ.get("TRACE_HIDE_OUTPUT") == "1"

# ANSI helpers
def C(code, s):
    if not sys.stdout.isatty():
        return s
    return f"\033[{code}m{s}\033[0m"
BOLD = lambda s: C("1", s)
DIM = lambda s: C("2", s)
RED = lambda s: C("31", s)
GRN = lambda s: C("32", s)
YEL = lambda s: C("33", s)
BLU = lambda s: C("34", s)
MAG = lambda s: C("35", s)
CYN = lambda s: C("36", s)

events = []
with open(audit_path, "r") as f:
    for line in f:
        try:
            d = json.loads(line)
        except Exception:
            continue
        r = d.get("record") or {}
        corr = r.get("correlation") or {}
        if corr.get("workflowInstanceId") != WF:
            continue
        if STAGE and STAGE.lower() not in (corr.get("traceId") or "").lower():
            continue
        ts = r.get("timestamp") or ""
        if SINCE and ts < SINCE:
            continue
        kind = d.get("kind") or "?"
        if TOOL and (kind != "tool_invocation" or r.get("tool_name") != TOOL):
            continue
        events.append((ts, kind, r))

events.sort(key=lambda x: x[0])
if TAIL > 0:
    events = events[-TAIL:]

if not events:
    print(f"(no audit events found for workflowInstanceId={WF})")
    sys.exit(0)

# Header
trace_ids = sorted({(r.get("correlation") or {}).get("traceId") or "?" for _, _, r in events})
print(BOLD(f"━━━ Trace for workflow {WF} ━━━"))
print(DIM(f"  events: {len(events)}   trace_ids: {', '.join(trace_ids[:4])}{'...' if len(trace_ids)>4 else ''}"))
print()

def fmt_ts(ts: str) -> str:
    # 2026-05-21T05:08:04.123Z → 05:08:04.123
    if "T" in ts:
        t = ts.split("T", 1)[1].rstrip("Z")
        return t[:12]
    return ts

def trunc(s: str, n: int) -> str:
    s = s.replace("\n", " ⏎ ").replace("\r", "")
    return s if len(s) <= n else s[: n - 1] + "…"

last_step = None
for ts, kind, r in events:
    short_ts = fmt_ts(ts)

    if kind == "llm_call":
        step = r.get("step_index")
        if step != last_step:
            print()
            print(BOLD(MAG(f"┌─ step {step if step is not None else '?'} ─────────────────────────────")))
            last_step = step

        model = r.get("model_alias") or r.get("model") or "?"
        in_t = r.get("input_tokens", "?")
        out_t = r.get("output_tokens", "?")
        finish = r.get("finish_reason", "?")
        latency = r.get("latency_ms", "?")

        print(f"{DIM(short_ts)}  {BLU('LLM →')}  {BOLD(model)}  "
              f"{DIM(f'in={in_t}tok out={out_t}tok lat={latency}ms finish={finish}')}")

        if not HIDE_PROMPT and r.get("prompt_messages_preview"):
            for m in r["prompt_messages_preview"]:
                role = m.get("role", "?")
                tag = {
                    "system": YEL("[sys ]"),
                    "user":   GRN("[user]"),
                    "assistant": CYN("[asst]"),
                    "tool":   MAG("[tool]"),
                }.get(role, f"[{role[:4]}]")
                tool_hint = f" ← {m['tool_name']}" if m.get("tool_name") else ""
                content = trunc(m.get("content_preview") or "", 280)
                print(f"           {tag}{tool_hint}  {content}")

        text = r.get("response_text")
        if text:
            print(f"           {CYN('[asst→text]')}  {trunc(text, 320)}")
        tcs = r.get("response_tool_calls") or []
        for tc in tcs:
            print(f"           {CYN('[asst→call]')}  {BOLD(tc['name'])}({tc.get('args_preview','')})")

    elif kind == "tool_invocation":
        name = r.get("tool_name") or "?"
        args = r.get("args") or {}
        out = r.get("output")
        err = r.get("error")
        latency = r.get("latency_ms")
        ok = r.get("success", out is not None)
        ok_glyph = GRN("✓") if ok else RED("✗")

        # Compact args preview (first 3 keys)
        args_items = list(args.items())[:3] if isinstance(args, dict) else []
        args_str = ", ".join(f"{k}={trunc(json.dumps(v) if not isinstance(v,str) else v, 60)}" for k,v in args_items)

        print(f"{DIM(short_ts)}  {ok_glyph} {YEL('TOOL ')}  {BOLD(name)}({args_str})  "
              f"{DIM(f'lat={latency}ms' if latency else '')}")

        if not HIDE_OUTPUT:
            if err:
                print(f"           {RED('[err ]')}  {trunc(err, 320)}")
            elif isinstance(out, dict):
                # Pick a useful summary depending on shape
                if "matches" in out and isinstance(out["matches"], list):
                    print(f"           {DIM('[out ]')}  matches={len(out['matches'])}"
                          + (f" → {trunc(json.dumps(out['matches'][0]), 220)}" if out['matches'] else ""))
                elif "hits" in out and isinstance(out["hits"], list):
                    sample = out['hits'][0] if out['hits'] else None
                    print(f"           {DIM('[out ]')}  hits={out.get('count', len(out['hits']))}"
                          + (f" → {trunc(json.dumps(sample), 220)}" if sample else ""))
                elif "entries" in out and isinstance(out["entries"], list):
                    print(f"           {DIM('[out ]')}  entries={len(out['entries'])}")
                elif "content" in out:
                    bytes_ = out.get("bytes") or len(str(out.get("content","")))
                    print(f"           {DIM('[out ]')}  bytes={bytes_} truncated={out.get('truncated', False)}")
                elif "diff" in out:
                    diff = out.get("diff", "")
                    line_count = diff.count("\n")
                    paths = out.get("paths_touched") or []
                    print(f"           {DIM('[out ]')}  diff: {line_count} lines, paths={paths}")
                elif "status" in out:
                    print(f"           {DIM('[out ]')}  status={out['status']} "
                          + " ".join(f"{k}={v}" for k,v in out.items() if k != "status" and not isinstance(v, (dict, list)))[:200])
                else:
                    print(f"           {DIM('[out ]')}  {trunc(json.dumps(out), 320)}")
            elif out is not None:
                print(f"           {DIM('[out ]')}  {trunc(str(out), 320)}")

    else:
        # artifact / code_change / other — terse summary
        label = kind.upper()
        summary = []
        for k in ("tool_name", "paths_touched", "label", "artifact_type"):
            if k in r and r[k]:
                summary.append(f"{k}={r[k] if not isinstance(r[k], (dict, list)) else json.dumps(r[k])[:80]}")
        print(f"{DIM(short_ts)}  · {DIM(label)}  {' '.join(summary)[:240]}")

print()
print(BOLD(DIM("━━━ end of trace ━━━")))
PY
