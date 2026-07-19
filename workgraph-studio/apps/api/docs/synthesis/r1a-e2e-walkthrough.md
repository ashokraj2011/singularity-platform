# Synthesis Studio R1A — end-to-end walkthrough (§13 Definition of Done)

This runbook verifies the whole R1A agent loop against a **running stack** (platform-web +
workgraph-api + IAM + Postgres). It is the one check that cannot be done in a bare clone,
because the synthesis surface is auth-gated and the agent turn calls Context Fabric.

Each step lists the **UI action**, the **API call** it drives, and what to **assert**. The
browser reaches the backend through the `/api/workgraph` proxy, which rewrites
`/api/workgraph/synthesis/*` → the backend's `/api/synthesis/*` and forwards your bearer +
tenant headers. Direct `curl` uses the backend path `/api/synthesis/*` with an
`Authorization: Bearer <token>` header.

The DoD this proves: *a product owner opens a project, starts a Working Session, tags
transcripts + claims + a decision, asks the Facilitator to draft a PRD, sees every
source/assumption, asks the Evidence Curator for contradictions and the Requirements Editor
for improvements, reviews changes as proposal items, accepts some / rejects others, saves
PRD v1, sends it for review, and reopens later with full context, history, cost and
receipts — and **no agent can directly mutate an approved or human-owned record.***

---

## 0. Prerequisites

- The stack is up and you can sign in to platform-web; you have a valid session (the browser
  holds the bearer token; for `curl`, export `TOKEN=<bearer>` and `BASE=<workgraph-api-url>`).
- A **SpecificationProject** exists with a little substance to reference: at least one
  Assumption Room with a couple of **claims**, one or more **sources** (intake documents),
  and one recorded **decision** (DecisionDossier/DecisionOption). Seed via the existing
  `/synthesis` screens (Intake, Assumption Rooms, Decision Records) if empty.
- Note the project id (`?project=<id>` in any synthesis URL, or `GET /api/synthesis/workspaces`
  errors will echo it).

Throughout, `$P` = specificationProjectId, `$W` = workspaceId, `$T` = threadId,
`$PR` = proposalId, `$D` = documentId.

---

## 1. Open the initiative in a Working Session

- **UI:** Go to `/synthesis` and select the initiative in the picker. Click **Open in
  Working Session** (workbar) — or the **Working Session** link in the **Ask** panel — to land
  on `/synthesis/session?project=$P`.
- **API:** the screen creates/opens the session workspace and its working thread:
  ```
  POST /api/synthesis/workspaces        { "specificationProjectId": "$P", "title": "PRD working session" }  → $W
  POST /api/synthesis/workspaces/$W/threads { "kind": "WORKING_SESSION", "agentRole": "FACILITATOR" }      → $T
  ```
- **Assert:** the three-pane layout renders — **Context Library** (left) · **Working Artifact**
  (centre) · **Agent Conversation** (right). The workspace is scoped to `$P`.

## 2. Tag context — transcripts, claims, a decision

- **UI:** In the **Context Library**, add references: a source/transcript, one or two claims,
  and the decision.
- **API:** one call per reference (the ref is resolved once for label/version/hash/authz):
  ```
  POST /api/synthesis/workspaces/$W/context-refs { "entityType": "SOURCE",   "entityId": "<sourceId>" }
  POST /api/synthesis/workspaces/$W/context-refs { "entityType": "CLAIM",    "entityId": "<claimId>",  "referenceMode": "PINNED" }
  POST /api/synthesis/workspaces/$W/context-refs { "entityType": "DECISION", "entityId": "<decisionId>" }
  ```
- **Assert:** `GET …/context-refs` lists them with a resolved `label` and `authzDecision.exists = true`.
  A **PINNED** claim carries a `versionId` + `contentHash` (or is flagged "cannot pin" if the
  federated claim has no resolvable version — expected for claim-registry claims).

## 3. Ask the Facilitator to draft a PRD

- **UI:** In the **Agent Conversation**, with the Facilitator selected, send *"Draft a PRD from
  the tagged sources and decision."*
- **API:**
  ```
  POST /api/synthesis/workspaces/$W/threads/$T/agent-turn { "role": "FACILITATOR", "message": "Draft a PRD …" }
  ```
- **Assert:** the response carries a `disposition` and, for a material draft, a `proposalId`
  (not a mutation). The assistant message references a `contextManifestId`. **Nothing** in the
  domain has changed yet.

## 4. Inspect the Context Manifest (sources + assumptions + cost)

- **UI:** Open the manifest preview on the Facilitator's response.
- **API:** the manifest was persisted **before** the turn (it gates the run):
  ```
  GET /api/synthesis/workspaces/$W/manifests/<contextManifestId>
  ```
- **Assert:** it lists the frozen resolved snapshots of exactly the refs from step 2, plus
  `tokenEstimate`, `pinnedCount` / `followingCount`, a `classificationSummary`, and a stable
  `manifestHash`. This is the "sees every source/assumption" guarantee — the agent could only
  read what the manifest declares.

## 5. Ask the Evidence Curator for contradictions

- **UI:** Switch the conversation agent to **Evidence Curator**; ask *"Find contradictions
  among the tagged claims."*
- **API:** `POST …/agent-turn { "role": "EVIDENCE_CURATOR", "message": "…" }`
- **Assert:** contradictions come back as **verdicts / flags** (voice, not vote) and, at most,
  a PENDING proposal — **the target claims/rooms are unchanged**. `GET` the referenced claim and
  confirm its content/version did not move.

## 6. Ask the Requirements Editor to improve requirements

- **UI:** Switch to **Requirements Editor**; ask *"Tighten the acceptance criteria and flag
  untestable requirements."*
- **API:** `POST …/agent-turn { "role": "REQUIREMENTS_EDITOR", "message": "…" }`
- **Assert:** improvements arrive as proposal items (tracked diffs). If any item targets an
  **APPROVED** SpecificationVersion it is refused/So-marked — the editor can only touch DRAFT.

## 7. Review changes as proposal items — accept some, reject some

- **UI:** In the proposal review pane, accept a subset and reject the rest.
- **API:**
  ```
  GET  /api/synthesis/workspaces/$W/proposals                         → list ($PR + items)
  GET  /api/synthesis/proposals/$PR                                   → items with per-item baseContentHash
  POST /api/synthesis/proposals/$PR/decide {
    "decisions": [
      { "itemId": "<a>", "decision": "ACCEPT", "currentContentHash": "<hash>" },
      { "itemId": "<b>", "decision": "REJECT" }
    ] }
  ```
- **Assert:** accepted items become `APPLIED` (each with an `appliedReceipt`); rejected become
  `REJECTED`; an item whose target moved since drafting comes back `STALE` (not silently applied)
  and must be **rebased** (`POST …/items/:itemId/rebase`) before it can be accepted. This is the
  content-hash stale fence. **Only here — on human accept — does any domain table mutate.**

## 8. Save PRD v1 (bound to a SpecificationVersion)

- **UI:** Save the working artifact as **PRD v1**.
- **API:**
  ```
  POST /api/synthesis/documents { "specificationProjectId": "$P", "docType": "PRD",
                                  "title": "PRD v1", "specificationVersionId": "<specVersionId>" }  → $D
  ```
- **Assert:** a PRD/BRD is **spec-bound** — it must carry a `specificationVersionId` and owns no
  duplicate content (the SpecificationVersion stays the system-of-record). A READOUT/DIGEST/
  NARRATIVE instead gets its own DocumentVersion + blocks.

## 9. Send for review

- **UI:** Click **Send for review**.
- **API:** `POST /api/synthesis/documents/$D/transition { "to": "IN_REVIEW" }`
- **Assert:** the transition is legal (DRAFT → IN_REVIEW). Later, `APPROVED` requires an
  **independent reviewer** (author ≠ approver) and freezes every block PINNED + stamps a
  `contentHash` — try approving as the author and confirm it is refused.

## 10. Reopen later with full context, history, cost, receipts

- **UI:** Navigate away, then reopen `/synthesis/session?project=$P`.
- **API:**
  ```
  GET /api/synthesis/workspaces/$W                          → threads, lastActivityAt
  GET /api/synthesis/workspaces/$W/threads/$T/messages      → the full fenced transcript
  ```
- **Assert:** the transcript replays in order (gap-free `seq`), each assistant turn still linked
  to its `contextManifestId`, `proposalId`, `correlation` (cfCallId/traceId/receipts) and
  `tokens`. Nothing was lost.

---

## Security & governance assertions (the guarantees R1A must keep)

1. **No agent auto-mutation.** Every material agent turn produced a **PENDING** proposal, never a
   write. Grep the transcript: no domain row changed between step 3 and the human accept in step 7.
2. **Prohibited-autonomous deny-list.** Ask an agent to do a prohibited action directly (e.g.
   *"approve this spec"* / *"complete the work item"*). Assert it is **blocked** even though the
   agent's ceiling is L2 — it never appears as an executable item.
3. **Record-status guard.** A proposal item targeting an APPROVED/PUBLISHED/human-owned record is
   refused at apply (defence-in-depth, re-checked on accept — agent output is untrusted).
4. **Tenant isolation (RLS).** With a second tenant's session, `GET` this workspace / a claim / a
   room → **NotFound** (not another tenant's data). This is the forced-RLS behaviour verified on a
   throwaway Postgres (see the RLS enablement PR): an unwrapped or wrong-tenant read returns **0
   rows**; a cross-tenant write hits a WITH CHECK violation.
5. **Manifest on every material response.** Each assistant turn carries an inspectable
   `contextManifestId`; there is no un-manifested material response.

---

## Endpoint quick reference

| Purpose | Method + path (backend; prefix `/api/workgraph` from the browser) |
|---|---|
| Open/list workspaces | `POST/GET /api/synthesis/workspaces` |
| Threads | `POST/GET /api/synthesis/workspaces/:w/threads` |
| Messages (fenced) | `POST/GET /api/synthesis/workspaces/:w/threads/:t/messages` |
| Context refs | `POST/GET/DELETE /api/synthesis/workspaces/:w/context-refs` |
| Context manifest | `POST /api/synthesis/workspaces/:w/threads/:t/manifest` · `GET …/manifests/:id` |
| Agent turn | `POST /api/synthesis/workspaces/:w/threads/:t/agent-turn` `{ role, message }` |
| Ask sidecar | `POST/GET /api/synthesis/ask` `{ specificationProjectId \| workspaceId, question }` |
| Proposals | `GET …/workspaces/:w/proposals` · `GET /api/synthesis/proposals/:id` · `POST …/:id/decide` · `POST …/:id/items/:item/rebase` |
| Documents | `POST/GET /api/synthesis/documents` · `GET/POST …/:id/transition` · block CRUD under `…/:id/blocks` |

Agent roles: `FACILITATOR`, `EVIDENCE_CURATOR`, `REQUIREMENTS_EDITOR`.
