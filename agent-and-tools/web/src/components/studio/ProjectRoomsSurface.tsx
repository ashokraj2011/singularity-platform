"use client";

import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { Plus, Sparkles, Flame, User, RefreshCw } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Rooms & Claims — the demand-side epistemic surface (Phase 1). A Room is an ephemeral exploration
 * over the project; Claims are hypotheses carrying a Beta posterior + a human steward; you estimate
 * P(true) as a number and the estimates pool. Variance across estimators = where the team is most
 * ignorant ("most contested"). An AI peer proposes framings you accept. Backed by /api/studio (#490).
 */

type ClaimType = "MARKET" | "USER" | "OPERATIONAL" | "TECHNICAL";
type Room = { id: string; title: string; state: string; claimCount?: number };
type Claim = {
  id: string; statement: string; riskiestAssumption: string | null; claimType: ClaimType;
  status: string; stewardId: string; mean: number; concentration: number; disagreement: number;
  estimateCount: number;
};
type Candidate = { statement: string; riskiestAssumption?: string; claimType?: ClaimType; selfEstimate: number; rationale?: string };
type ProposeResult = { reply: string; claims: Candidate[]; traceId: string };

export function ProjectRoomsSurface({ projectId }: { projectId: string }) {
  const roomsQ = useSWR<{ items: Room[] }>(`/studio/projects/${projectId}/rooms`, (u: string) => workgraphFetch<{ items: Room[] }>(u));
  const rooms = roomsQ.data?.items ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeRoom = rooms.find((r) => r.id === activeId) ?? rooms[0] ?? null;
  const [newRoom, setNewRoom] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function createRoom() {
    if (!newRoom.trim()) return;
    setErr(null);
    try {
      const room = await workgraphFetch<Room>(`/studio/projects/${projectId}/rooms`, { method: "POST", body: JSON.stringify({ title: newRoom.trim() }) });
      setNewRoom(""); await roomsQ.mutate(); setActiveId(room.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not create the room."); }
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ ...intro }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}>Rooms &amp; Claims</h2>
          <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--studio-ink-dim)" }}>
            Explore before you commit. Each claim is a hypothesis with a belief (a probability), not a task — and where you disagree is where you&apos;re most ignorant.
          </p>
        </div>
        <button style={ghost} onClick={() => roomsQ.mutate()} title="Refresh"><RefreshCw size={13} /></button>
      </div>

      {err && <div style={errorBanner}>{err}</div>}

      {/* Room selector */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
        {rooms.map((r) => (
          <button key={r.id} onClick={() => setActiveId(r.id)} style={roomChip(activeRoom?.id === r.id)}>
            {r.title}
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", color: "var(--studio-muted)", marginLeft: 2 }}>{r.state}</span>
            {typeof r.claimCount === "number" && <span style={{ fontSize: 10.5, color: "var(--studio-faint)" }}>· {r.claimCount}</span>}
          </button>
        ))}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={newRoom} onChange={(e) => setNewRoom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createRoom()} placeholder="New room…" style={{ ...input, width: 150 }} />
          <button style={primary} onClick={createRoom} disabled={!newRoom.trim()}><Plus size={13} /> Room</button>
        </div>
      </div>

      {roomsQ.isLoading ? <p style={muted}>Loading…</p>
        : !activeRoom ? (
          <div style={{ ...panel, padding: 26, textAlign: "center" }}>
            <Sparkles size={26} style={{ color: "var(--studio-accent-2)" }} />
            <p style={{ margin: "10px 0 0", fontWeight: 700 }}>No rooms yet</p>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--studio-ink-dim)" }}>Open a room to start probing the riskiest assumptions behind this project.</p>
          </div>
        ) : <RoomPanel projectId={projectId} room={activeRoom} />}
    </div>
  );
}

function RoomPanel({ projectId, room }: { projectId: string; room: Room }) {
  const [contested, setContested] = useState(false);
  const claimsQ = useSWR<{ items: Claim[] }>(
    `/studio/projects/${projectId}/claims?roomId=${room.id}&contested=${contested}`,
    (u: string) => workgraphFetch<{ items: Claim[] }>(u),
    { refreshInterval: 12000 },
  );
  const claims = claimsQ.data?.items ?? [];
  const [err, setErr] = useState<string | null>(null);
  const mutate = () => claimsQ.mutate();

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--studio-muted)" }}>Claims</span>
        <button onClick={() => setContested((v) => !v)} style={toggle(contested)} title="Rank by estimator disagreement — where the team is most ignorant">
          <Flame size={12} /> Most contested
        </button>
        <span style={{ marginLeft: "auto" }} />
      </div>
      {contested && <p style={{ margin: "-6px 0 14px", fontSize: 11.5, color: "var(--studio-warn)" }}>Ranked by disagreement — the claims your team is most split on rise to the top of the probe queue.</p>}

      {err && <div style={errorBanner}>{err}</div>}

      <AddClaim projectId={projectId} roomId={room.id} onAdded={mutate} onError={setErr} />
      <CopilotPanel projectId={projectId} roomId={room.id} onAccepted={mutate} onError={setErr} />

      {claimsQ.isLoading ? <p style={muted}>Loading…</p>
        : claims.length === 0 ? <div style={{ ...panel, padding: 18, fontSize: 12.5, color: "var(--studio-ink-dim)" }}>No claims yet. Add a hypothesis, or ask the AI peer to propose framings.</div>
        : <div style={{ display: "grid", gap: 10 }}>{claims.map((c) => <ClaimCard key={c.id} claim={c} onEstimated={mutate} onError={setErr} />)}</div>}
    </div>
  );
}

function ClaimCard({ claim, onEstimated, onError }: { claim: Claim; onEstimated: () => void; onError: (m: string) => void }) {
  const [val, setVal] = useState(Math.round(claim.mean * 100));
  const [saving, setSaving] = useState(false);
  const level = claim.disagreement > 0.06 ? "high" : claim.disagreement > 0.02 ? "mid" : "low";

  async function submit() {
    setSaving(true);
    try {
      await workgraphFetch(`/studio/claims/${claim.id}/estimate`, { method: "POST", body: JSON.stringify({ probability: val / 100 }) });
      onEstimated();
    } catch (e) { onError(e instanceof Error ? e.message : "Could not record the estimate."); }
    finally { setSaving(false); }
  }

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
        <span style={typeChip}>{claim.claimType.toLowerCase()}</span>
        <span style={{ fontSize: 10.5, color: "var(--studio-muted)" }}>{claim.status.toLowerCase()}</span>
        {level !== "low" && <span style={contestedBadge(level)}><Flame size={10} /> contested {claim.disagreement.toFixed(2)}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--studio-muted)" }}>
          <User size={11} /> {claim.stewardId.slice(0, 14)} · {claim.estimateCount} est
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 650, lineHeight: 1.45, color: "var(--studio-ink)" }}>{claim.statement}</div>
      {claim.riskiestAssumption && <div style={{ fontSize: 12, color: "var(--studio-ink-dim)", marginTop: 4 }}><span style={{ color: "var(--studio-muted)", fontWeight: 700 }}>Riskiest:</span> {claim.riskiestAssumption}</div>}

      {/* Posterior gauge */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={gaugeTrack}><div style={{ ...gaugeFill, width: `${Math.round(claim.mean * 100)}%` }} /></div>
        </div>
        <div style={{ fontFamily: "var(--studio-mono)", fontSize: 15, fontWeight: 800, color: "var(--studio-accent-2)", fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right" }}>{Math.round(claim.mean * 100)}%</div>
        <div style={{ fontSize: 10.5, color: "var(--studio-muted)", minWidth: 56 }}>P(true)<br />n≈{claim.concentration.toFixed(1)}</div>
      </div>

      {/* Estimate slider */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--studio-line-soft)" }}>
        <span style={{ fontSize: 11, color: "var(--studio-muted)", flex: "none" }}>Your estimate</span>
        <input type="range" min={0} max={100} value={val} onChange={(e) => setVal(Number(e.target.value))} style={{ flex: 1, accentColor: "var(--studio-accent)" }} />
        <span style={{ fontFamily: "var(--studio-mono)", fontSize: 12.5, fontWeight: 700, minWidth: 40, textAlign: "right" }}>{val}%</span>
        <button style={primary} onClick={submit} disabled={saving}>{saving ? "…" : "Submit"}</button>
      </div>
    </div>
  );
}

function AddClaim({ projectId, roomId, onAdded, onError }: { projectId: string; roomId: string; onAdded: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [risk, setRisk] = useState("");
  const [type, setType] = useState<ClaimType>("TECHNICAL");
  const [est, setEst] = useState(50);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!statement.trim()) return;
    setBusy(true);
    try {
      await workgraphFetch(`/studio/projects/${projectId}/claims`, { method: "POST", body: JSON.stringify({ roomId, statement: statement.trim(), riskiestAssumption: risk.trim() || undefined, claimType: type, initialEstimate: est / 100 }) });
      setStatement(""); setRisk(""); setEst(50); setOpen(false); onAdded();
    } catch (e) { onError(e instanceof Error ? e.message : "Could not add the claim."); }
    finally { setBusy(false); }
  }

  if (!open) return <button style={{ ...ghost, marginBottom: 14 }} onClick={() => setOpen(true)}><Plus size={13} /> Add claim</button>;
  return (
    <div style={{ ...panel, background: "var(--studio-panel-2)", marginBottom: 14, display: "grid", gap: 9 }}>
      <input autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="A claim — e.g. 'Users will trust an AI-drafted refund reason enough to not call support.'" style={input} />
      <input value={risk} onChange={(e) => setRisk(e.target.value)} placeholder="Riskiest assumption (what would sink this if wrong?)" style={input} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={type} onChange={(e) => setType(e.target.value as ClaimType)} style={{ ...input, width: 150 }}>
          {(["MARKET", "USER", "OPERATIONAL", "TECHNICAL"] as ClaimType[]).map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
        </select>
        <span style={{ fontSize: 11, color: "var(--studio-muted)" }}>Your P(true)</span>
        <input type="range" min={0} max={100} value={est} onChange={(e) => setEst(Number(e.target.value))} style={{ width: 130, accentColor: "var(--studio-accent)" }} />
        <span style={{ fontFamily: "var(--studio-mono)", fontSize: 12, minWidth: 38 }}>{est}%</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={ghost} onClick={() => setOpen(false)}>Cancel</button>
          <button style={primary} onClick={add} disabled={!statement.trim() || busy}>{busy ? "Adding…" : "Add claim"}</button>
        </div>
      </div>
    </div>
  );
}

function CopilotPanel({ projectId, roomId, onAccepted, onError }: { projectId: string; roomId: string; onAccepted: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [accepting, setAccepting] = useState<number | null>(null);

  async function propose() {
    if (!prompt.trim()) return;
    setBusy(true); setResult(null);
    try {
      setResult(await workgraphFetch<ProposeResult>(`/studio/rooms/${roomId}/copilot/propose`, { method: "POST", body: JSON.stringify({ prompt: prompt.trim() }) }));
    } catch (e) { onError(e instanceof Error ? e.message : "The AI peer could not respond (the model bridge may be down)."); }
    finally { setBusy(false); }
  }
  async function accept(c: Candidate, i: number) {
    if (!result) return;
    setAccepting(i);
    try {
      await workgraphFetch(`/studio/rooms/${roomId}/copilot/accept`, { method: "POST", body: JSON.stringify({ ...c, traceId: result.traceId }) });
      setResult({ ...result, claims: result.claims.filter((_, j) => j !== i) });
      onAccepted();
    } catch (e) { onError(e instanceof Error ? e.message : "Could not accept the claim."); }
    finally { setAccepting(null); }
  }

  if (!open) return <button style={{ ...aiBtn, marginBottom: 14 }} onClick={() => setOpen(true)}><Sparkles size={13} /> AI: propose framings</button>;
  return (
    <div style={{ ...panel, background: "var(--studio-panel-2)", border: "1px solid var(--studio-accent)", marginBottom: 14, display: "grid", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Sparkles size={14} style={{ color: "var(--studio-accent-2)" }} />
        <b style={{ fontSize: 13 }}>AI peer — propose framings</b>
        <button style={{ ...ghost, marginLeft: "auto", padding: "4px 9px" }} onClick={() => setOpen(false)}>Close</button>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the room probe? e.g. 'Frame the problem behind our refund SLA — structurally distinct angles, each with its riskiest assumption.'" style={{ ...input, minHeight: 60, resize: "vertical" }} />
      <div><button style={aiBtn} onClick={propose} disabled={!prompt.trim() || busy}>{busy ? "Thinking…" : "Propose"}</button></div>
      {result && (
        <div style={{ display: "grid", gap: 8 }}>
          {result.reply && <p style={{ margin: 0, fontSize: 12, color: "var(--studio-ink-dim)", lineHeight: 1.5 }}>{result.reply}</p>}
          {result.claims.map((c, i) => (
            <div key={i} style={{ ...panel, background: "var(--studio-panel)", padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                {c.claimType && <span style={typeChip}>{c.claimType.toLowerCase()}</span>}
                <span style={{ fontSize: 11, color: "var(--studio-accent-2)", fontFamily: "var(--studio-mono)" }}>AI P≈{Math.round(c.selfEstimate * 100)}%</span>
                <button style={{ ...primary, marginLeft: "auto", padding: "5px 11px" }} onClick={() => accept(c, i)} disabled={accepting === i}>{accepting === i ? "…" : "Accept"}</button>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.statement}</div>
              {c.riskiestAssumption && <div style={{ fontSize: 11.5, color: "var(--studio-ink-dim)", marginTop: 3 }}><span style={{ color: "var(--studio-muted)", fontWeight: 700 }}>Riskiest:</span> {c.riskiestAssumption}</div>}
              {c.rationale && <div style={{ fontSize: 11, color: "var(--studio-muted)", marginTop: 3, fontStyle: "italic" }}>{c.rationale}</div>}
            </div>
          ))}
          <p style={{ margin: 0, fontSize: 10.5, color: "var(--studio-faint)" }}>Accepting makes you the claim&apos;s steward; the AI&apos;s estimate is recorded as a peer&apos;s.</p>
        </div>
      )}
    </div>
  );
}

// ── styles (dark ELM Studio tokens) ──
const muted: CSSProperties = { color: "var(--studio-ink-dim)" };
const intro: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 };
const panel: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 12, padding: 14 };
const input: CSSProperties = { width: "100%", padding: "8px 11px", borderRadius: 8, fontSize: 13, border: "1px solid var(--studio-line)", background: "var(--studio-chrome)", color: "var(--studio-ink)" };
const primary: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: "var(--studio-accent)", color: "#fff", border: "none", borderRadius: 8, padding: "7px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const ghost: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, background: "var(--studio-panel-2)", color: "var(--studio-ink)", border: "1px solid var(--studio-line)", borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 650, cursor: "pointer" };
const aiBtn: CSSProperties = { ...primary, background: "var(--studio-accent-soft)", color: "var(--studio-accent-2)", border: "1px solid var(--studio-accent)" };
const typeChip: CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--studio-accent-2)", background: "var(--studio-accent-soft)", borderRadius: 5, padding: "2px 7px" };
const gaugeTrack: CSSProperties = { height: 8, borderRadius: 999, background: "var(--studio-line)", overflow: "hidden" };
const gaugeFill: CSSProperties = { height: "100%", borderRadius: 999, background: "linear-gradient(90deg, var(--studio-accent), var(--studio-accent-2))" };
const errorBanner: CSSProperties = { marginBottom: 14, padding: "10px 14px", fontSize: 12.5, color: "#fecaca", background: "rgba(242,104,138,0.12)", border: "1px solid var(--studio-bad)", borderRadius: 10 };

function roomChip(active: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", borderRadius: 9, fontSize: 12.5, fontWeight: 650, cursor: "pointer",
    border: `1px solid ${active ? "var(--studio-accent)" : "var(--studio-line)"}`, background: active ? "var(--studio-accent-soft)" : "var(--studio-panel-2)", color: active ? "var(--studio-accent-2)" : "var(--studio-ink)" };
}
function toggle(on: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 8, fontSize: 11.5, fontWeight: 650, cursor: "pointer",
    border: `1px solid ${on ? "var(--studio-warn)" : "var(--studio-line)"}`, background: on ? "rgba(245,181,68,0.14)" : "var(--studio-panel-2)", color: on ? "var(--studio-warn)" : "var(--studio-ink-dim)" };
}
function contestedBadge(level: "mid" | "high"): CSSProperties {
  const c = level === "high" ? "var(--studio-bad)" : "var(--studio-warn)";
  return { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: c, background: level === "high" ? "rgba(242,104,138,0.14)" : "rgba(245,181,68,0.14)", borderRadius: 5, padding: "2px 7px" };
}
