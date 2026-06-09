# Copilot SDLC workflow — working dir, artifacts, refinement, clarifications

The product shape for the Copilot-CLI SDLC (the `AGENT_TASK executor:'copilot'`
flow). Four pieces; piece 1 is built, 2–4 are designed here.

## 1. Working directory → clone → run → check in  ✅ built

Each copilot phase runs **in a real clone of the target repo**, and commits its
changes so the workflow can push them.

- **Clone (once, reused across stages).** `AgentTaskExecutor` puts the repo in
  `run_context.source_uri` for copilot nodes — from `node.config.sourceUri` or the
  work item's `{{vars.repoUrl}}`. mcp-server's `/mcp/tool-run` then materializes it
  (`ensureWorkspaceSource`, idempotent) into the **work-item sandbox** `wi/<code>`
  under `MCP_SANDBOX_ROOT` (`$HOME/.singularity/mcp-workspace`, outside the platform
  repo). Every stage of the run keys off the same `wi/<code>` worktree, so changes
  accumulate.
- **Run.** `copilot_execute` runs `copilot -p "<task>" --allow-all` with `cwd =`
  that sandbox clone.
- **Check in.** `copilot_execute` then `git add -A` + commits onto the work-item
  branch (`commit:false` to skip; message defaults to `copilot: <task line>`),
  returning `commitSha`. Each phase = one commit.
- **Push.** The workflow's terminal `GIT_PUSH` node pushes the work-item branch to
  the remote.

**Required:** the work item must carry a **`repoUrl`** var (or the node a
`sourceUri`). Without it, no clone happens and Copilot has nothing to work on.

## 2. Each stage shows its artifacts  🔵 design

Every copilot phase already writes an `AgentRunOutput` (the CLI summary) + an output
artifact via `createAgentOutputArtifact`, and the receipt carries `diff` +
`changedPaths` + `commitSha`. To surface them per stage:

- **Capture** the receipt's `diff`/`changedPaths`/`commitSha` into the node's output
  artifact `payload` (so the run timeline has the file list + diff, not just text).
- **Render** in workgraph-web's run/node view: a "Stage artifacts" panel listing
  changed files (link to the commit) + the produced docs (REQUIREMENTS.md, DESIGN.md,
  …) read from the work-item branch at `commitSha`.

Hook: `AgentTaskExecutor` persists `correlation.changedPaths`/`workspaceCommitSha`
already for the cloud loop; mirror that for the copilot branch, and add the panel in
the run view.

## 3. Refine a stage  🔵 design

A copilot node ends `AWAITING_REVIEW`. Refinement = rework with feedback instead of
approve:

- Add a **"Refine"** action on the node review (alongside approve) that re-runs the
  node with `vars.refine_feedback` set.
- `AgentTaskExecutor` appends the feedback to the copilot task
  (`<task>\n\n## Reviewer feedback to address\n<feedback>`) and re-dispatches
  `copilot_execute` in the **same** `wi/<code>` worktree (so it amends/extends the
  prior commit, `commit:true` makes a follow-up commit). Loop until approved.

This reuses the existing AGENT_TASK rework/`send-back` machinery — the only new bit
is threading `refine_feedback` into the copilot task.

## 4. Surface Copilot's clarifications  🔵 design

`copilot -p --allow-all` is non-interactive — it makes assumptions and proceeds
rather than blocking on a question. So "clarifications" = surfacing what it
*assumed / asked*:

- **Parse** the CLI summary for assumption/question markers ("I assumed…", "It's
  unclear…", "Please confirm…", trailing "?") into a `clarifications: string[]` on
  the receipt.
- **Surface** them in the stage-artifacts panel as "Copilot's open questions", and
  feed an answer back through the **Refine** path (piece 3) — the answer becomes
  `refine_feedback`.
- Future: drive the phase through the §13.4 `laptop-invocations/:id/questions`
  +`/questions/stream` endpoints for true interactive Q&A when a Desktop client hosts
  the run.

## Status
| Piece | State |
|---|---|
| 1 working-dir / clone / check-in | ✅ built (this PR) |
| 2 stage artifacts surfaced | 🔵 designed |
| 3 refine a stage | 🔵 designed |
| 4 surface clarifications | 🔵 designed |
