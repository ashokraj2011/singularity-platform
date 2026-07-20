# The Conversational Studio ("the big screen")

**Status:** the guarded document-ingestion slice, initial conversational
conductor/dual-pane surface, event-level SSE stream, proposal-card rendering,
and direct in-thread source attachment are implemented in this checkout. The
specification was introduced in
`dca399eb` (#566) and its current implementation baseline was refreshed against
`main` at `90eb9fb9` (#567).

This is a **completion spec, not a greenfield one**. The R1A `synthesis/` module
already provides the workspace/thread/message substrate, the governed agent-turn
driver, three agents, the proposal apply-registry and ask-with-history. The
`experience/` module provides intake sessions, artifact validation → transmute →
canonical-document, scaffold accept and the morning brief.

What remains is the deeper card protocol and attachment lifecycle work: live
gate/plan/contradiction cards, automatic evidence turns, and human-reviewed
attachment state transitions. The first usable conductor surface now unifies the existing agent
turn, manifest, proposal, document, and context-reference services without
adding a parallel mutation path.

---

## Why

Synthesis Studio presents 22 screens across five phases. That is right for
someone who knows the model and wrong for a product owner opening it the first
time, who has no way to tell which of the 22 to touch now. #565 added an *order*
over those screens because it could not change the surface count. This changes
the surface count.

The design move that separates this from a chatbot bolted onto a PM tool: it is
never chat-only. **Dual pane** — conversation left, workspace materialising right
— so every agent turn produces visible structure, not just words. You talk, the
graph grows, and you can always see what the talking built. That is what prevents
the classic conversational failure: thirty minutes of good discussion that
produced nothing durable.

---

## Verified state of `main`

| Layer | On main | This spec adds |
|---|---|---|
| Thread substrate | Workspace / Thread / Message, context-refs, immutable ContextManifest per turn | Message *kinds* (CARD, ATTACHMENT, SYSTEM_STATE); thread↔initiative binding checks |
| Agent turns | `runAgentTurn` — single governed turn, ∩ permissions, autonomy disposition, PENDING proposals, honest failure notes | The **Conductor**: role-free turns routed to the right engine; phase state machine |
| Agents | FACILITATOR, EVIDENCE_CURATOR, REQUIREMENTS_EDITOR @ L2_PROPOSE | Conductor as router, not a fourth persona |
| Proposals | create / decide / rebase; apply-registry with EDIT_DOC_BLOCK + ADD_DOC_BLOCK wired, other verbs throwing by design | Wire the remaining verbs; inline proposal rendering |
| Intake | session / turn / scaffold / accept | Conducted *through* the thread instead of a separate surface |
| Artifacts | validation reports, transmute, canonical-document (`experience.router.ts:77,81`) | In-thread upload → truthful ATTACHMENT message; deeper completion cards remain planned |
| Ask | `/synthesis/ask` + history | Routed by the Conductor when a turn is a question |
| Gates & generation | compile + gate; plans/validate/apply + receipts | GATE / PLAN card protocol; cards call existing endpoints |
| Happy path | 7-step guided order (#565) | The same 7 steps become the thread's phase chips |
| UI | — | The dual-pane screen at `/synthesis/studio` |

### ⚠️ Correction to the original plan — document ingestion was a real dependency

The original draft stated *"Dependencies: none on unbuilt work — every card
targets an endpoint already on main."* **That is not true of file ingestion**,
and file ingestion is what the flagship demo opens with.

Verified on the `main` baseline:

- `board-ingestion.service.ts` **hard-rejected `storageRef`**:
  `'storageRef ingestion is not configured for this deployment; provide extracted content or a URL.'`
- The parser supported **`TEXT`, `MARKDOWN`, `MD`, `URL` only**. PDF / DOCX /
  PPTX / XLSX were noted in-file as pluggable but absent.
- The only PDF/DOCX dependency in the repo is in
  `business-alignment.exports.ts` — a document **writer**, for generating signed
  readouts. A docx writer is not a docx reader.

So "drop the BRD and the deck" depends on unbuilt work: storage, extraction, a
parser registry, and per-format failure semantics. **It is the highest-risk item
in the plan and it must be its own slice**, ahead of the conversational work —
not folded into a sprint that also builds evidence flow and wires two apply
verbs. It is independently valuable: it unblocks the *existing* intake surface
whether or not the dual pane ships.

The existing text/URL path now preserves this same failure contract: a claim
extractor timeout or malformed response leaves the source placed on the board but
marks the artifact `FAILED`; a valid empty envelope is `VALID_EMPTY`, and a mixed
valid/invalid bare array is `PARTIAL`. No extraction error is represented as
`COMPLETED`.

**Implemented S0 slice in this checkout.** The default parser registry now reads
PDF, DOCX, PPTX, and XLSX content into addressable source spans. `storageRef` is
accepted only as a path relative to `STUDIO_INGEST_STORAGE_ROOT`; the service
resolves the real path, rejects traversal and symlink escape, requires a regular
file, and enforces a 500 KB bound. URL ingestion uses the existing SSRF guard,
rejects credentials and redirects, and applies the same bound. Binary parser
errors set the artifact to `FAILED` and never emit a successful completion event.
The default Office readers intentionally cover text extraction, not layout,
charts, formulas, images, or macros. The intake screen now exposes the guarded
multipart upload route; provider-specific adapters remain follow-on work.

**Implemented S1/S2 slice in this checkout.** `/synthesis/studio` is now the
primary Synthesis entry. It creates or reuses a tenant-scoped workspace and
working thread, routes each turn deterministically to the Facilitator, Evidence
Curator, or Requirements Editor, records the routing decision as a fenced
`SYSTEM_STATE` message, and delegates execution to the existing governed agent
turn. The right-hand pane is a server-backed projection of phase, next action,
sources, documents, proposals, and pending review. The thread also exposes an
authenticated event-level SSE stream with a bounded polling projector and
heartbeat, plus a multipart attachment route that reuses guarded board
ingestion. Proposal-producing turns render as CARD messages. Pane and artifact
state events remain follow-on work.

### Invariant the spec correctly respects

`experience.service.ts:365` refuses requirements from intake scaffolds:
*"Intake scaffolds must not manufacture requirements; requirements are earned
after evidence review."* The design honours this — `ADD_REQUIREMENT` routes
through the studio-spec section patch, never the scaffold, and `REVISE` against
an approved spec routes to a ChangeRequest rather than a direct edit. Keep it
that way; the error message exists because someone decided this deliberately.

---

## Product shape

One screen, two panes, one graph. Left: the initiative's durable, multiplayer,
event-sourced thread. Right: a live projection of what the conversation built —
claims, requirements, decisions, contested items, phase progress. Bottom: a
composer accepting text, files and (later) voice.

The user never selects an agent, names an artifact type, or navigates to a gate.
Behind every visible element sits an existing governed endpoint: **the screen
introduces zero new mutation paths.**

The seven phases from #565 are unchanged — Frame → Fund → Bring in what you know
→ Capture & challenge facts → Choose an approach → Write the specification →
Generate the work — rendered as header chips, derived server-side, never
user-toggled. "Open full studio" keeps all 22 screens one click away:
conversation for flow, canvas for craft, same graph underneath.

**Non-goals (v1):** voice transcription (button present, wired later) ·
multi-workspace threads · agent-to-agent turns in-thread · mobile ·
token-by-token streaming (event-level first).

---

## Message model

`Message.kind`, new column, default `TEXT`:

- **`TEXT`** — human or agent prose; agent prose obeys the citation contract.
- **`ATTACHMENT`** — `{ artifactId, filename, mime, lifecycle }`, lifecycle being
  the truthful chain `UPLOADED → PARSING → EXTRACTING → {SUCCEEDED | VALID_EMPTY
  | PARTIAL | FAILED} → HUMAN_REVIEWED`. Updated in place, revision-tracked. **A
  failed extraction renders as failed, never as silent completion.**
- **`CARD`** — `{ cardType, payload, actions[] }`. v1 types: `EVIDENCE`, `CONTRADICTION`,
  `SCAFFOLD_REVIEW`, `PROPOSAL`, `GATE`, `PLAN`, `RECEIPT`, `BRIEF`,
  `PROBE_OFFER`. Every action carries its target endpoint and args; the client
  POSTs to the **existing** route. Cards are remote controls, not new APIs.
- **`SYSTEM_STATE`** — phase transitions, joins, honest failure notes.

Cards are live: a GATE card re-renders as checks change; an acted-on card shows
its outcome and disables its actions (targets are already idempotent server-side).

---

## The Conductor

`POST /synthesis/workspaces/:id/threads/:tid/converse { text }` plus
`POST /synthesis/workspaces/:id/threads/:tid/attachments` (multipart field
`file`) for direct source attachment.
— the screen's single entry point. `agent-turn` remains for direct/tool use.

**Routing, deterministic first:**

1. **Attachments present** → the attachment route ingests the file through the
   guarded board pipeline and appends an ATTACHMENT message. Automatic Evidence
   Curator turns after extraction remain a follow-on slice.
2. **Card follow-ups** (`inReplyTo`) → straight to that card's engine, no
   classification.
3. **Interrogatives** → `ask.service`, scoped to the workspace's context-refs;
   cites, or says "we don't know" with a probe offer.
4. **Phase directives** → a cheap governed classifier with strict enum output
   (`FRAME | EVIDENCE | DECIDE | SPECIFY | GENERATE | QUESTION | CHITCHAT`)
   selects the engine.
5. **Ambiguity** → asks in one sentence with the two readings as buttons. It
   never guesses on a mutation-bound route.

The Conductor is a **router, not a persona**: no tools, no proposals, and its
classifier output is logged with the turn so routing itself is auditable.
Misroutes are corrected conversationally, which re-routes with the classifier
bypassed.

**Streaming.** SSE per thread: `message.appended` is implemented now, with
heartbeats and a bounded polling projector. `message.updated`, `pane.updated`,
`phase.changed`, and `turn.status` remain the next event-level additions. The
stream is event-granular — a turn appears when complete — and leaves the
governed-turn contract untouched. Token-level streaming is a later change
inside `executeGovernedTurn` only.

**Pane.** `GET /synthesis/workspaces/:id/pane` — a read-model projection,
event-refreshed: counters, top-N claims by stakes×recency with confidence,
requirement quality summary, decisions, phase progress, economics headline. Every
row deep-links to its full-studio surface. Server-authoritative; the client only
formats.

**Phase derivation.** A pure function over the workspace. Phases **can regress**
— a failed compile returns SPECIFY — and the chips show that honestly. GATE and
PLAN cards are *emitted by phase transitions*, not requested; green gates emit a
one-line SYSTEM_STATE rather than a card demanding attention.

---

## Apply-registry completion

Wire the throwing verbs to existing domain services. The registry's design —
untrusted content, re-validate, tenant-scoped service, accepted-but-not-applied
on error — is right; this is wiring, not design.

`PROPOSE_CLAIM` → claims service (steward required, source cited, honest tier) ·
`FLAG_CONTRADICTION` → tension/verdict path · `ADD_REQUIREMENT` /
`REVISE_REQUIREMENT` / `ADD_ACCEPTANCE` → studio-spec section patch,
revision-checked, **REVISE against an approved spec routing to a ChangeRequest**.

Each wired verb ships with a **prompt-injection test**: a malicious diff (wrong
tenant, forged id, out-of-bounds field) must be rejected by the service layer,
not by the registry's good intentions.

---

## Plan

Revised from the original five sprints: **document ingestion is pulled out ahead
of the conversational work** for the reasons in the correction above.

- **S0 — Document ingestion (implemented in this checkout).** Storage-root
  guarded source resolution, parser registry (PDF/DOCX/PPTX/XLSX), per-format
  failure semantics, and `storageRef` path support. *Demo: place a real BRD
  under `STUDIO_INGEST_STORAGE_ROOT`, call the existing ingest endpoint with its
  relative `storageRef`, and see extracted claims.*
- **S1 — Message kinds + SSE + pane (partially implemented).** The pane read
  model, thread projection, polling refresh, system-state route messages, and
  bounded authenticated SSE stream are shipped. Pane/event fan-out and formal
  message-kind migration remain. *Demo: a live thread with a live pane.*
- **S2 — Conductor v1 + intake-in-thread (initial slice implemented).**
  Deterministic routes, governed role delegation, and the no-role-picker Studio
  surface are shipped. The five-stage intake protocol, classifier, and
  SCAFFOLD_REVIEW card remain. *Demo: blank thread → routed governed turn.*
- **S3 — Evidence flow (1.5 wk).** Evidence Curator auto-turn on completion;
  CONTRADICTION and PROPOSAL cards; PROBE_OFFER. Wire
  `PROPOSE_CLAIM` + `FLAG_CONTRADICTION`. *Demo: drop two documents, adjudicate a
  real contradiction.*
- **S4 — Gates + generation (1.5 wk).** Phase derivation; GATE and PLAN cards on
  transitions; wire the requirement verbs including the ChangeRequest route.
  *Demo: the full arc.*
- **S5 — Polish + hardening (1 wk).** Chronicler in-thread; card idempotency and
  double-action tests; injection suite per verb; accessibility; phase-regression
  honesty tests; SSE fan-out load test.

**Risks.** Classifier misroutes — mitigated by deterministic-first, the
one-question ambiguity rule, logged decisions and conversational correction. SSE
without sticky sessions — fallback is a 3s poll of the same read models, same
contracts. Pane projector staleness — bind refresh to the outbox and alert on
divergence.

---

## Acceptance criteria

1. A product owner reaches an accepted scaffold from a blank thread without
   seeing an agent name, artifact type, or internal noun.
2. A dropped document whose extraction fails **shows failed**; nothing downstream
   claims completeness. *(Guard this hardest — a conversational surface makes
   silent partial success very easy to ship.)*
3. Every card action round-trips through an existing governed endpoint; **grep
   proves the screen added zero mutation routes.**
4. A contradiction between two dropped sources is adjudicated in-thread and lands
   as a recorded decision.
5. The GATE waive path requires a typed reason, and the waiver appears in the
   compile record verbatim.
6. PLAN apply produces a RECEIPT whose work-item IDs resolve in the full studio
   with spec-hash bindings.
7. Every routed turn logs its routing decision; a sampled audit of 50 turns shows
   the misroute rate and each correction.
8. The prompt-injection suite passes for every wired apply verb.
9. The thread survives reload, multiplayer join and a week of gaps; "distill this
   thread" produces an accepted fact batch.
10. The full arc runs in under ten minutes in front of a skeptical audience.

Criterion 3 is the one with a mechanical check, and it is what keeps this a
presentation layer rather than a second API.
