# Git History Change Explainer

Use `bin/explain-git-history.py` when you need to explain what changed between two dates using only local git history. It is designed for release notes, delivery evidence packs, audit reviews, and "what changed since last week?" operator questions.

The report is deterministic and offline. It does not call an LLM. It derives the explanation from commit subjects, changed paths, cumulative file churn, and simple category/risk heuristics.

## Platform Web UI

Open the VS Code-style frontend:

```text
http://localhost:5180/operations/git-history
```

The UI lets you choose a date range, path filters, author filter, merge behavior, markdown/JSON output, and max commit count. It renders the report in an editor-like view with tabs for markdown, JSON, and command output.

The web API follows the platform runtime model by default:

```text
Browser -> Platform Web -> Context Fabric /api/runtime-bridge/tool-run -> MCP runtime -> git_history_explain
```

That means the git checkout and git credentials live with the connected MCP runtime, not in the browser or the Platform Web container. Context Fabric routes the request by the verified caller identity when available, then by these deployment hints:

```bash
GIT_HISTORY_RUNTIME_USER_ID=<iam-user-id>      # personal runtime routing
GIT_HISTORY_RUNTIME_TENANT_ID=<tenant-id>      # shared tenant runtime routing
GIT_HISTORY_SOURCE_URI=https://github.com/org/repo
GIT_HISTORY_SOURCE_REF=main
```

For local single-user development, if exactly one runtime is connected, Platform Web can infer that runtime from `/api/runtime-bridge/status`. In multi-user or strict environments, pass a real caller bearer token or set the runtime user/tenant env explicitly.

Local Platform Web execution is debug-only. Enable it only when you intentionally want the Next server to run the script against a mounted checkout:

```bash
GIT_HISTORY_LOCAL_FALLBACK_ENABLED=true
GIT_HISTORY_REPO=/path/to/singularity-platform
```

The UI status bar shows whether a report was served by the Runtime Bridge or by the explicit local debug fallback.

## Basic Usage

```bash
bin/explain-git-history.py 2026-06-20 2026-07-02
```

Date-only values are expanded to the full day:

- `since` becomes `YYYY-MM-DD 00:00:00`
- `until` becomes `YYYY-MM-DD 23:59:59`

Limit the explanation to one area of the monorepo:

```bash
bin/explain-git-history.py \
  --since "2026-06-20 09:00" \
  --until "2026-06-21 18:00" \
  --path agent-and-tools/web
```

Write the report into an evidence folder:

```bash
bin/explain-git-history.py 2026-06-20 2026-07-02 \
  --output evidence/git-history-2026-06-20-to-2026-07-02.md
```

Emit JSON for another workflow or API:

```bash
bin/explain-git-history.py 2026-06-20 2026-07-02 --format json
```

## Useful Options

```text
--path <path>        Limit to a path. Repeat it for multiple paths.
--author <pattern>   Apply git's author filter.
--no-merges          Exclude merge commits.
--max-commits <n>    Cap the number of commits explained. Default: 250.
--format markdown    Human-readable report. Default.
--format json        Machine-readable report.
--output <file>      Write to a file instead of stdout.
--repo <path>        Explain another git repository.
```

## What The Report Contains

- Executive summary of the selected date range.
- Category breakdown across frontend, Workgraph, agent runtime, Context Fabric/MCP/LLM, governance, scripts, docs, tests, and data/migrations.
- Recent commit subjects per category.
- Hot files by cumulative churn.
- Risk signals for auth, tenant isolation, migrations, runtime routing, deployment scripts, and deletion-heavy changes.
- Suggested verification commands based on changed areas.
- Commit timeline and top changed files table.

## Release Evidence Pattern

For a release evidence pack, run:

```bash
SINCE="2026-06-20"
UNTIL="2026-07-02"
mkdir -p evidence/release-$UNTIL

bin/explain-git-history.py "$SINCE" "$UNTIL" \
  --output "evidence/release-$UNTIL/git-history.md"

bin/explain-git-history.py "$SINCE" "$UNTIL" \
  --format json \
  --output "evidence/release-$UNTIL/git-history.json"
```

Attach the markdown report to the delivery evidence pack and keep the JSON output for automation, dashboards, or workflow governance gates.
