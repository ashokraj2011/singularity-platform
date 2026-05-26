# M83 — IDE-style develop stage in the workbench

Spec for turning the develop / qa-review / test-certification stages
into a hands-on operator surface: file browser, code editor, test
runner, and API caller — all bound to the workitem's `wi/<code>`
branch that M81 made the long-lived home for agent + human work.

## Why this matters

Today the operator's only develop-stage affordance is "approve /
send back / mark done." When the agent gets stuck or makes a wrong
call, the human's only recourse is to write a send-back annotation
and burn another LLM attempt. The work itself lives in the
workitem's git worktree on `mcp-server/.docker-sandbox/.singularity/
workitems/<code>/`, but the workbench has no way to see, edit, or
run that code.

Three pain points this milestone removes:

1. **Black-box dev stage.** Operators can't see the agent's output
   without leaving the workbench. They open IntelliJ on the host
   path (which we taught them in the troubleshooting session) and
   then come back to the workbench to approve. That's not a flow.

2. **No human-in-the-loop edits.** When the agent gets 90% there
   but flubs the last 10% (e.g. a typo, a missing import, a unit
   test that should assert one extra thing), the only fix is to
   send back and pray. There's no path to "I'll edit this one line
   and move on."

3. **No "does the app actually work" check.** Tests passing in
   isolation isn't the same as "the service boots and the
   `/operators/containsACharacter` endpoint returns 200 for
   `(haystack='Hello', needle='e')`." Today QA can run tests but
   can't smoke an actual API.

## What we're building

Four UI slices, each independently shippable, on the develop stage
view (and reused by qa-review / test-certification):

```
┌──────────────────────────────────────────────────────────────────┐
│  Develop · wi/WRK-984AD · 3 commits ahead of main                 │
├────────────────────────┬─────────────────────────────────────────┤
│  [S1] File tree         │  [S2] Monaco editor                     │
│  ─ src                  │  ┌────────────────────────────────────┐ │
│    ─ main               │  │ 113   case containsACharacter: {   │ │
│      ─ java/…            │  │ 114     String h = lower(left);   │ │
│        Operator.java    │  │ 115     return h.indexOf(…)…       │ │
│        RuleEngineSer…   │  │ 116   }                             │ │
│    ─ test                │  └────────────────────────────────────┘ │
│  ─ pom.xml              │  [Save]   [Discard]                     │
│                         ├─────────────────────────────────────────┤
│  [S3] Test runner        │  [S4] API caller                        │
│  $ mvn -q test          │  POST /operators/containsACharacter     │
│  ─────────────────────  │  Body: { "haystack":"Hello","needle":… │
│  Tests run: 14, Pass…   │  → 200 OK { "matches": true }            │
└────────────────────────┴─────────────────────────────────────────┘
```

Slices stack: S1 alone is useful ("let me see what the agent did").
S1+S2 lets a human ship the last-mile edit. S1+S2+S3 closes the
inner verification loop. All four = a real workbench-as-IDE.

## Scope guard rails

- **Same workitem only.** Every endpoint enforces the path is
  inside `<workitems_root>/<workItemCode>/`. The operator can't
  read or write anything in another workitem or outside the
  worktree root. Path-traversal checks happen server-side; the
  client just sends relative paths.

- **No new build images.** The mcp-sandbox-runner already has
  every toolchain the project would need (maven, gradle, python,
  node, go, rust, dotnet). M83 reuses that runner verbatim for
  tests + app launch. We're not making "operator IDE container."

- **Human commits, not human merges.** Operator edits create
  commits on the same `wi/<code>` branch agents commit to,
  attributed to the operator's IAM identity. No separate
  `hu/<code>` branch (we picked this in the AskUserQuestion). The
  audit trail shows who edited what, not a parallel timeline.

- **Read-only by default in non-dev stages.** S1 (file browser) +
  S3 (test runner) work on any stage. S2 (editor) + S4 (API
  caller) only render for stages with `toolPolicy === 'MUTATION'`
  or `toolPolicy === 'VERIFICATION'` per the workflow node config.
  Operators can browse + test from a security-review stage but
  not edit code.

---

## Slice 1 — File browser

**Goal:** show the working tree of `wi/<workItemCode>` from the
workbench, no editing, no shell. Closes "I want to see what the
agent did" without leaving the UI.

### API

```
GET /api/blueprint/sessions/:id/worktree/tree?path=src/main
→ {
    workItemCode: "WRK-984AD",
    branch: "wi/WRK-984AD",
    branchCommitsAhead: 3,
    path: "src/main",
    entries: [
      { name: "java", type: "dir" },
      { name: "resources", type: "dir" }
    ]
  }

GET /api/blueprint/sessions/:id/worktree/file?path=src/main/java/.../Operator.java
→ {
    path: "src/main/java/.../Operator.java",
    sizeBytes: 1843,
    sha: "9eb3048…",          ← last commit that touched this file
    encoding: "utf-8",
    content: "package org.example.rules;\n\npublic enum…"
  }
```

### Server logic

- Resolve `workItemCode` from the session's metadata (set during
  WORKBENCH_TASK activation).
- Compute the worktree root: `<MCP_RUNNER_HOST_WORKSPACE_PATH>/.singularity/workitems/<workItemCode>/`.
- Normalize the request path; refuse if the resolved absolute path
  doesn't start with the worktree root.
- Refuse paths matching `.gitignore` (use `git check-ignore` via
  the runner, OR ship a simple `node-ignore` parse).
- Cap response: 5 MB per file read, 5000 entries per directory.
- Files in `.git/`, `node_modules/`, `target/`, `dist/` filtered
  out by default unless `?showHidden=true` is passed.

### UI

- New `<WorktreeBrowser>` component, mounted as a left rail on the
  develop / qa-review / test-cert stage views.
- Tree fetched lazily per directory expansion. Persistent expanded
  state in `useState` per stage view (resets on stage change).
- Selecting a file emits `onFileSelect(path)` which the parent
  uses to drive Slice 2 (editor) or just show a read-only preview
  for now.
- Files the agent's most recent attempt touched (from
  `correlation.codeChangeRecords[*].paths_touched`) get a small
  badge `agent` next to the filename. Helps operators audit-by-eye.

### Effort: ~2 days

---

## Slice 2 — Monaco editor + human-attributed commit

**Goal:** click a file in S1 → it opens in Monaco. Edit. Save
creates a commit on `wi/<code>` with author = the operator's IAM
identity.

### API

```
PUT /api/blueprint/sessions/:id/worktree/file
{
  path: "src/main/java/.../Operator.java",
  content: "package org.example.rules;\n…",
  message?: "Fix typo in containsACharacter case",
  expectedSha?: "9eb3048…"      ← optimistic concurrency, server
                                  refuses if branch tip moved
}
→ {
    path: "src/main/java/.../Operator.java",
    sha: "abc1234…",             ← new commit
    branch: "wi/WRK-984AD",
    author: { email: "ashok.nair.raj@…", iamId: "2eff…" },
    diff: "@@ -113,4 +113,5 …",
    pushedToOrigin: false        ← M81 push-failure is not a
                                   stage failure (matches dev path)
  }
```

### Server logic

- Same path normalization + ignore filter as S1.
- Refuse if `expectedSha` is present and doesn't match the file's
  current sha on `wi/<code>` (operator was looking at a stale view;
  client should refresh and re-edit).
- Run via the existing mcp-sandbox-runner — spawn a one-shot
  container with the worktree mounted, do `git config user.email
  <iam.email>`, `git add <path>`, `git commit -m <message>`. This
  reuses the M81 wi/branch flow and the M83 persistent build cache.
- Author email pulled from `req.user!.email` (IAM identity, not the
  agent's `mcp@local` constant). Message defaults to
  `Human edit by <email>: <generated-summary>` if not supplied.
- Best-effort push to origin (same `MCP_WORK_BRANCH_PUSH_ON_FINISH`
  env, same 403-is-not-a-failure semantics as `finish_work_branch`
  per the earlier ast-tools.ts commit).
- Emit `BlueprintWorktreeFileEdited` audit event with the diff
  summary (path + lines added/removed) and the resulting commit
  SHA.

### UI

- `@monaco-editor/react` pulled in as a new dep (~3 MB, lazy-loaded
  via dynamic import so it doesn't bloat the initial bundle).
- Save button disabled while the file is being saved; after save,
  reload the file from server and re-fetch the tree so commit
  badges update.
- Show a diff preview before commit (Monaco's `DiffEditor`).
- "Push failed (403): see audit-gov for token guidance" toast when
  `pushedToOrigin === false` — mirrors what we already do for the
  agent's finish_work_branch.

### Concurrency model

`expectedSha` makes saves optimistically race-safe vs. agent
attempts on the same wi/<code> branch. If an agent re-run lands a
commit while the operator is editing, the next save fails fast
with a 409 + the latest content, operator merges, retries.

### Effort: ~3 days

---

## Slice 3 — Test runner with SSE-streamed output

**Goal:** click "Run tests" button → workbench streams the
runner's stdout/stderr line-by-line into a terminal pane. Persists
the test-result receipt as a verification artifact attached to
the stage attempt.

### API

```
POST /api/blueprint/sessions/:id/worktree/run-test
{
  command: "mvn",              ← whitelisted, same set as runner
  args: ["-B", "test"],
  cwd?: "."                    ← relative to worktree root
}
→ 200 OK, body is text/event-stream:

  event: started
  data: {"runId":"…","commandPreview":"mvn -B test","timeoutSec":120}

  event: stdout
  data: {"line":"[INFO] --- maven-surefire-plugin:test ---"}

  event: stdout
  data: {"line":"Tests run: 14, Failures: 0, Errors: 0, Skipped: 0"}

  event: finished
  data: {
    "exitCode": 0,
    "passed": true,
    "durationMs": 4823,
    "verificationReceipt": { …same shape as agent receipts }
  }
```

### Server logic

- Calls the existing `mcp-sandbox-runner /v1/execute` (which now
  has the persistent .m2 cache from `f47efd2`, so this is
  near-instant for warm workitems).
- Wraps the runner's once-shot HTTP response in SSE chunks. v1
  buffers stdout server-side then flushes on completion — true
  line-by-line streaming requires a small runner change to chunk
  the response (followup, not blocking).
- The resulting verification receipt is persisted to the **latest
  attempt's** `correlation.verificationReceipts` array, attributed
  to the operator (`origin: 'human'`). The downstream verification
  gate (we have this for dev stages) treats human-origin receipts
  the same as agent-origin.

### UI

- "Run tests" button in S3 panel — picks `mvn test` / `pytest` /
  `npm test` based on the project type detector (read pom.xml /
  package.json / pyproject.toml at the worktree root).
- Terminal pane: xterm.js or a simple `<pre>` with virtualized
  scroll. Auto-scrolls unless the operator scrolls up.
- On finish, the verification receipt shows up in the existing
  evidence section of the approval card. No new UI for the
  receipt itself — reuses what we have.

### Why SSE not WebSocket

The runner's existing `/v1/execute` is HTTP. SSE is a one-way
stream that fits naturally over the same auth + nginx path. The
workbench is already using SSE for audit-gov live tail, so the
client code reuses that pattern.

### Effort: ~2 days (runner chunk-streaming is a stretch goal)

---

## Slice 4 — API caller + port-forward to running app

**Goal:** click "Bring app up" → runner boots the project's
service (e.g. `mvn spring-boot:run`, `npm start`, `python -m
service`). workgraph-api proxies inbound requests to the running
container's port. Workbench shows a Postman-style request builder
that hits the proxied URL.

This is the largest slice and the highest-value one (matches the
user's "testing using api calls" ask). It splits into sub-slices:

### S4.a — `bring up` lifecycle

```
POST /api/blueprint/sessions/:id/worktree/serve
{
  command: "mvn",
  args: ["spring-boot:run"],
  expectedPort: 8080,           ← workitem author hint; defaults to
                                  parsing from application.properties /
                                  package.json scripts
  idleTimeoutSec?: 600          ← auto-shutdown after no traffic
}
→ {
    serveId: "srv-<uuid>",
    forwardedUrl: "http://localhost:8080/proxy/srv-<uuid>/",
    status: "starting",         ← starting | ready | failed | shutdown
    logsStreamUrl: "/api/.../serve/srv-<uuid>/logs"
  }

DELETE /api/blueprint/sessions/:id/worktree/serve/srv-<uuid>
→ shuts down the container
```

- Spawns a long-running runner container (not the per-call one-shot
  used by `/v1/execute`). Different runner endpoint or a new
  "service mode" flag.
- Server-side TCP probe waits for `expectedPort` to accept
  connections before transitioning `status` to `ready`.
- Idle timeout: track last request to the forwarded URL; after
  `idleTimeoutSec` with no traffic, server SIGTERMs the container.

### S4.b — proxy path

```
ANY /api/blueprint/sessions/:id/proxy/<serveId>/<path*>
  ↓ forwards to → http://<container>:<expectedPort>/<path*>
```

- Workgraph-api proxies arbitrary methods + headers + bodies.
- CORS: origin enforcement so only the workbench origin can hit
  the proxy. No public exposure.
- Refuses if the `serveId` isn't associated with the current
  session (multi-tenant safety).

### S4.c — Postman-style UI

- Method + URL builder (URL prefilled with the proxied base).
- Headers table.
- Body (JSON / form / raw).
- "Send" → render response status + headers + body (with JSON
  syntax highlighting).
- Saved requests per session (workbench LocalStorage v1; backend
  persistence is a followup).

### Security model

- Container runs with `--read-only`, `--cap-drop ALL`, no host
  network — same hardening as the runner one-shots.
- `--network bridge` (project deps need to fetch transitive
  things at boot). Followup: pre-warm a cache and flip to
  `--network none`.
- Per-session, per-serve port-forward. No global registry of
  forwarded URLs — exact route binding lives in workgraph-api
  memory + a `BlueprintWorktreeServe` row keyed on `serveId`.
- Auto-shutdown on `idleTimeoutSec` AND on session close AND on
  stage advance (the next stage shouldn't inherit the agent's
  test server).

### Effort: ~5 days for S4.a + S4.b + S4.c, plus 2 days hardening

---

## Composition with M81 per-workitem branch model

Agent commits today look like:

```
9eb3048 Singularity work item wi/WRK-984AD   ← MCP Server <mcp@local>
8d22f69 Singularity work item wi/WRK-984AD   ← MCP Server <mcp@local>
348b089 Singularity work item wi/WRK-984AD   ← MCP Server <mcp@local>
```

After M83 S2, the log interleaves:

```
def4567 Human edit by ashok.nair.raj@…: Fix typo in case branch
9eb3048 Singularity work item wi/WRK-984AD   ← MCP Server <mcp@local>
abc1234 Human edit by ashok.nair.raj@…: Add null guard
8d22f69 …
```

This is the right model — every change is attributable, the
audit-gov event trail shows who did what, and the downstream
stages (QA, release-readiness) treat `wi/<code>` as the canonical
state regardless of authorship.

The `loopStateHasAccumulatedCodeChange` guard we landed in
`1c6ae60` is unchanged: it just asks "does any attempt have code
change records?" The S2 commit is its own attempt-like entity
(with `attemptId: 'human-edit-<commitSha>'`) so the guard sees
it and approval can advance.

## Open questions

1. **Editor for non-developers.** Should QA-stage operators
   editing test files be considered "code mutation" requiring
   the same `MUTATION` policy as dev? The proposal above says
   yes — editor only renders if `toolPolicy === 'MUTATION'`. But
   QA legitimately authors `*.test.java` files. Maybe a finer
   axis: `canEditTests` vs. `canEditSource`. Defer to a v2.

2. **Conflicts with agent re-runs.** What if the operator is
   editing while the agent is running its own attempt? Today the
   no-parallel-attempts guard refuses concurrent attempts on the
   same stage. We'd need a "operator edit attempt" pseudo-attempt
   so the guard also refuses agent runs during human edits. Or
   accept the race: agent runs see the human's commit, treat it
   as accumulated state, move on.

3. **Test-runner output streaming.** SSE per Slice 3 buffers
   server-side then flushes. True line-by-line requires the
   runner to stream `docker logs --follow` instead of waiting for
   container exit. Two-week followup, not blocking M83 v1.

4. **API caller scope.** Slice 4 assumes the project's
   entrypoint is well-known (`spring-boot:run`, `npm start`,
   etc.). Multi-module projects + non-trivial bootstraps may
   need an entrypoint declared on the WORKBENCH_TASK node config.
   Treat this as the natural extension of `expectedPort`.

## Slicing summary

| Slice | Files touched | Estimated effort | Independently shippable? |
|---|---|---|---|
| S1 — File browser | 3 new endpoints + WorktreeBrowser component | 2 days | ✅ alone |
| S2 — Monaco editor + commit | 2 new endpoints, Monaco dep, commit util | 3 days | needs S1 |
| S3 — Test runner SSE | 1 new endpoint, terminal pane component | 2 days | needs S1; S2 helps but not required |
| S4 — API caller + proxy | Multiple endpoints, proxy middleware, lifecycle, UI | 5 + 2 days | needs S1; S3 helps for "is the app up" smoke |

Total: ~14 days for v1 of all four slices.

## Recommended ship order

1. S1 (file browser) + small CSS work.
2. S3 (test runner) — sidesteps the editor dep; immediate value.
3. S2 (editor + commit).
4. S4 (API caller + port forward) — biggest, save for last.

This order maximizes the operator's leverage at each step: at S1
they can see, at S3 they can verify, at S2 they can fix, at S4
they can smoke-test.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Path-traversal in worktree endpoints | Medium | Server-side absolute-path normalization + prefix check; deny `..`; deny symlinks pointing outside worktree |
| Operator commits poison wi/&lt;code&gt; for subsequent agent runs | Low | Agent prompt already explicitly handles "code already exists" (see attempt dea06240); human commits look identical to agent commits from the worktree perspective |
| Monaco bundle bloats the workbench | Medium | Lazy-load via dynamic import; ~3 MB on first edit only |
| Port-forwarded app is a security boundary violation | Medium | Same hardening as runner one-shots: read-only, cap-drop, bridge network only; per-session serveId; aggressive idle timeout |
| SSE connection drops mid-test-run | Low | Reuse audit-gov SSE reconnect logic; server-side runId means client can re-attach |
| Long-running serve containers leak | Medium | Idle timeout (S4.a) + sweeper job that kills any `BlueprintWorktreeServe` row older than N hours |

## Out of scope

- Multi-file commits in a single Save. (Operator edits one file at
  a time in v1.)
- Git branch operations from the UI (no checkout, no branch
  switching). The wi/&lt;code&gt; branch is the entire surface.
- Live collaboration / multi-operator simultaneous edit. Single
  session, single operator.
- IDE-grade features: refactoring, LSP, autocomplete beyond
  Monaco's basics. (Monaco gives syntax highlighting + bracket
  matching for free; that's the bar.)

## Verification

After all four slices land:

```bash
# S1
curl http://localhost:5176/api/blueprint/sessions/<id>/worktree/tree?path=src
# → { entries: [...] }

# S2
curl -X PUT http://localhost:5176/api/blueprint/sessions/<id>/worktree/file \
  -d '{"path":"README.md","content":"# edited\n"}'
# → { sha: "...", diff: "@@ ..." }
cd ~/Desktop/RuleEngine-WRK-984AD && git log --oneline -1
# → def4567 Human edit by ashok.nair.raj@gmail.com: Update README

# S3
curl -N -X POST http://localhost:5176/api/blueprint/sessions/<id>/worktree/run-test \
  -H 'accept: text/event-stream' \
  -d '{"command":"mvn","args":["test","-Dtest=RuleEngineServiceTest"]}'
# → SSE stream with stdout chunks, then finished event

# S4
curl -X POST http://localhost:5176/api/blueprint/sessions/<id>/worktree/serve \
  -d '{"command":"mvn","args":["spring-boot:run"],"expectedPort":8080}'
# → { forwardedUrl: "/proxy/srv-..." }
curl http://localhost:5176/api/blueprint/sessions/<id>/proxy/srv-.../operators
# → 200, response from the running app
```

End-to-end: an operator can take a 90%-done agent commit, fix the
last 10% inline, run the tests, smoke-test the API, and approve —
without ever leaving the workbench tab.
