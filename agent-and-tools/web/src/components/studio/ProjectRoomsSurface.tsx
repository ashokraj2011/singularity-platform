"use client";

import { useState, type CSSProperties } from "react";
import useSWR from "swr";
import { Plus, Sparkles, Flame } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Rooms & Claims — the demand-side epistemic surface, in the Linear-grade studio language. A claim is a
 * hypothesis carrying a Beta posterior (drawn as its actual distribution curve, not a bar) + a human
 * steward; you estimate P(true) as a number and the estimates pool; variance = where the team is most
 * ignorant; probes move the belief and a convergence meter says when to stop. Backed by /api/studio.
 */

type ClaimType = "MARKET" | "USER" | "OPERATIONAL" | "TECHNICAL";
type Room = { id: string; title: string; state: string; claimCount?: number };
type Claim = {
  id: string; statement: string; riskiestAssumption: string | null; claimType: ClaimType;
  status: string; stewardId: string; alpha: number; beta: number; mean: number; concentration: number;
  disagreement: number; estimateCount: number;
};
type Candidate = { statement: string; riskiestAssumption?: string; claimType?: ClaimType; selfEstimate: number; rationale?: string };
type ProposeResult = { reply: string; claims: Candidate[]; traceId: string };
type Convergence = { bestGainPerHour: number; converged: boolean; openProbes: number; bar: number };

// ── Beta PDF → SVG paths (the posterior's shape) ──
function betaCurve(alpha: number, beta: number, w: number, h: number) {
  const a = Math.max(0.05, alpha), b = Math.max(0.05, beta), N = 60, pad = 2;
  const ys: number[] = []; let max = 0;
  for (let i = 0; i <= N; i++) { const x = i / N; const y = Math.pow(x, a - 1) * Math.pow(1 - x, b - 1); ys.push(isFinite(y) ? y : 0); if (isFinite(y) && y > max) max = y; }
  if (!(max > 0)) max = 1;
  const pts = ys.map((y, i) => [(i / N) * w, h - pad - (Math.min(y, max) / max) * (h - pad * 2)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `M0 ${h} ${pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")} L${w} ${h} Z`;
  return { line, area, meanX: (a / (a + b)) * w };
}
function BetaCurve({ alpha, beta }: { alpha: number; beta: number }) {
  const W = 176, H = 46, { line, area, meanX } = betaCurve(alpha, beta, W, H);
  const id = `bc-${Math.round(alpha * 100)}-${Math.round(beta * 100)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 46, overflow: "visible" }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--studio-accent)" stopOpacity="0.5" />
        <stop offset="1" stopColor="var(--studio-accent)" stopOpacity="0.03" />
      </linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--studio-accent-2)" strokeWidth="1.5" />
      <line x1={meanX} x2={meanX} y1="0" y2={H} stroke="var(--studio-ink)" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
    </svg>
  );
}

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
    <div style={{ maxWidth: 940 }}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 640, letterSpacing: "-0.02em" }}>Rooms &amp; Claims</h2>
          <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--studio-muted)" }}>Explore before you commit. Each claim is a hypothesis with a belief — the curve is its posterior; where you disagree is where you&apos;re most ignorant.</p>
        </div>
      </div>

      {err && <div style={errorBanner}>{err}</div>}

      {/* Room selector + convergence */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 18, flexWrap: "wrap" }}>
        {rooms.map((r) => (
          <button key={r.id} className="rm-rchip" onClick={() => setActiveId(r.id)} style={roomChip(activeRoom?.id === r.id)}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--studio-good)" }} /> {r.title}
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", color: "var(--studio-muted)" }}>{r.state}</span>
          </button>
        ))}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={newRoom} onChange={(e) => setNewRoom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createRoom()} placeholder="New room…" className="rm-input" style={{ ...input, width: 132 }} />
          <button className="rm-btn" style={btn} onClick={createRoom} disabled={!newRoom.trim()}><Plus size={13} /></button>
        </div>
        {activeRoom && <ConvergenceMeter roomId={activeRoom.id} />}
      </div>

      {roomsQ.isLoading ? <p style={muted}>Loading…</p>
        : !activeRoom ? (
          <div style={{ ...panel, padding: 30, textAlign: "center", marginTop: 18 }}>
            <Sparkles size={24} style={{ color: "var(--studio-accent-2)" }} />
            <p style={{ margin: "10px 0 0", fontWeight: 600 }}>No rooms yet</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--studio-muted)" }}>Open a room to start probing the riskiest assumptions behind this project.</p>
          </div>
        ) : <RoomPanel projectId={projectId} room={activeRoom} />}
    </div>
  );
}

function ConvergenceMeter({ roomId }: { roomId: string }) {
  const { data } = useSWR<Convergence>(`/studio/rooms/${roomId}/convergence`, (u: string) => workgraphFetch<Convergence>(u), { refreshInterval: 15000 });
  if (!data) return null;
  const gain = data.bestGainPerHour;
  const frac = data.openProbes === 0 ? 0 : Math.max(0.04, Math.min(1, gain / (data.bar * 60)));
  const label = data.openProbes === 0 ? "no open probes" : data.converged ? "converged" : "keep probing";
  const color = data.openProbes === 0 ? "var(--studio-muted)" : data.converged ? "var(--studio-good)" : "var(--studio-warn)";
  return (
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 11, padding: "8px 13px", border: "1px solid var(--studio-line)", borderRadius: 10, background: "var(--studio-panel)" }} title="Best remaining probe's information gain per hour vs the convergence bar">
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--studio-muted)" }}>Convergence</span>
      <div style={{ width: 90, height: 5, borderRadius: 3, background: "var(--studio-line)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.round(frac * 100)}%`, borderRadius: 3, background: "linear-gradient(90deg, var(--studio-good), var(--studio-warn))" }} />
      </div>
      <span style={{ fontFamily: "var(--studio-mono)", fontSize: 12, fontWeight: 600 }}>{gain.toFixed(3)}<small style={{ color, fontWeight: 500 }}> /hr · {label}</small></span>
    </div>
  );
}

function RoomPanel({ projectId, room }: { projectId: string; room: Room }) {
  const [contested, setContested] = useState(false);
  const claimsQ = useSWR<{ items: Claim[] }>(`/studio/projects/${projectId}/claims?roomId=${room.id}&contested=${contested}`, (u: string) => workgraphFetch<{ items: Claim[] }>(u), { refreshInterval: 12000 });
  const claims = claimsQ.data?.items ?? [];
  const [err, setErr] = useState<string | null>(null);
  const mutate = () => claimsQ.mutate();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "22px 0 14px" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--studio-muted)" }}>Claims</span>
        {claims.length > 0 && <span style={{ color: "var(--studio-faint)", fontSize: 12 }}>· {claims.length}</span>}
        <button className="rm-btn" onClick={() => setContested((v) => !v)} style={{ ...btn, ...(contested ? { borderColor: "var(--studio-warn)", color: "var(--studio-warn)", background: "var(--studio-warn-soft)" } : {}) }} title="Rank by disagreement — where the team is most ignorant"><Flame size={12} /> Most contested</button>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <CopilotButtons projectId={projectId} roomId={room.id} onChanged={mutate} onError={setErr} />
        </div>
      </div>

      {err && <div style={errorBanner}>{err}</div>}
      <AddClaim projectId={projectId} roomId={room.id} onAdded={mutate} onError={setErr} />

      {claimsQ.isLoading ? <p style={muted}>Loading…</p>
        : claims.length === 0 ? <div style={{ ...panel, padding: 18, fontSize: 13, color: "var(--studio-muted)" }}>No claims yet. Add a hypothesis, or ask the AI peer to propose framings.</div>
        : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{claims.map((c) => <ClaimCard key={c.id} claim={c} onEstimated={mutate} onError={setErr} />)}</div>}

      <div style={{ marginTop: 20, fontSize: 12, color: "var(--studio-faint)" }}>Each claim is a hypothesis with a belief, not a task. Estimates shape the prior; evidence from probes moves it.</div>
    </div>
  );
}

function ClaimCard({ claim, onEstimated, onError }: { claim: Claim; onEstimated: () => void; onError: (m: string) => void }) {
  const mean = Math.round(claim.mean * 100);
  const [val, setVal] = useState(mean);
  const [saving, setSaving] = useState(false);
  const level = claim.disagreement > 0.06 ? "high" : claim.disagreement > 0.02 ? "mid" : null;

  async function submit() {
    setSaving(true);
    try { await workgraphFetch(`/studio/claims/${claim.id}/estimate`, { method: "POST", body: JSON.stringify({ probability: val / 100 }) }); onEstimated(); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not record the estimate."); }
    finally { setSaving(false); }
  }

  return (
    <div className="rm-claim" style={claimCard}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={typeChip}>{claim.claimType.toLowerCase()}</span>
        {level && <span style={{ ...chip, color: level === "high" ? "var(--studio-bad)" : "var(--studio-warn)", background: level === "high" ? "var(--studio-bad-soft)" : "var(--studio-warn-soft)", border: "1px solid transparent", display: "inline-flex", gap: 4, alignItems: "center" }}><Flame size={9} /> contested {claim.disagreement.toFixed(2)}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--studio-muted)" }}>
          <span style={{ ...face, width: 18, height: 18, fontSize: 8 }}>{initials(claim.stewardId)}</span>{claim.stewardId.slice(0, 14)} · {claim.estimateCount} est
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 176px", gap: 18, alignItems: "center" }} className="rm-cbody">
        <div>
          <div style={{ fontSize: 15, fontWeight: 540, lineHeight: 1.45, letterSpacing: "-0.012em" }}>{claim.statement}</div>
          {claim.riskiestAssumption && <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--studio-muted)", lineHeight: 1.45 }}><b style={{ color: "var(--studio-ink-dim)", fontWeight: 600 }}>Riskiest:</b> {claim.riskiestAssumption}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 13, paddingTop: 13, borderTop: "1px solid var(--studio-line)" }}>
            <span style={{ fontSize: 11.5, color: "var(--studio-muted)", flex: "none" }}>Your estimate</span>
            <input className="rm-rng" type="range" min={0} max={100} value={val} onChange={(e) => setVal(Number(e.target.value))} />
            <span style={{ fontFamily: "var(--studio-mono)", fontSize: 13, fontWeight: 600, minWidth: 40, textAlign: "right" }}>{val}%</span>
            <button className="rm-submit" style={submitBtn} onClick={submit} disabled={saving}>{saving ? "…" : "Submit"}</button>
          </div>
        </div>
        <div style={{ borderLeft: "1px solid var(--studio-line)", paddingLeft: 18 }} className="rm-belief">
          <BetaCurve alpha={claim.alpha} beta={claim.beta} />
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
            <span style={{ fontFamily: "var(--studio-mono)", fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>{mean}%</span>
            <span style={{ fontSize: 10.5, color: "var(--studio-muted)" }}>P(true)</span>
          </div>
          <div style={{ fontFamily: "var(--studio-mono)", fontSize: 10.5, color: "var(--studio-muted)", marginTop: 1 }}>n≈{claim.concentration.toFixed(1)} · β({claim.alpha.toFixed(1)}, {claim.beta.toFixed(1)})</div>
        </div>
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
    try { await workgraphFetch(`/studio/projects/${projectId}/claims`, { method: "POST", body: JSON.stringify({ roomId, statement: statement.trim(), riskiestAssumption: risk.trim() || undefined, claimType: type, initialEstimate: est / 100 }) }); setStatement(""); setRisk(""); setEst(50); setOpen(false); onAdded(); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not add the claim."); }
    finally { setBusy(false); }
  }

  if (!open) return <button className="rm-btn" style={{ ...btn, marginBottom: 14 }} onClick={() => setOpen(true)}><Plus size={13} /> Add claim</button>;
  return (
    <div style={{ ...panel, background: "var(--studio-panel-2)", marginBottom: 14, display: "grid", gap: 9, padding: 14 }}>
      <input autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="A claim — e.g. 'Users trust an AI-drafted refund reason enough to not call support.'" className="rm-input" style={input} />
      <input value={risk} onChange={(e) => setRisk(e.target.value)} placeholder="Riskiest assumption (what would sink this if wrong?)" className="rm-input" style={input} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={type} onChange={(e) => setType(e.target.value as ClaimType)} className="rm-input" style={{ ...input, width: 140 }}>
          {(["MARKET", "USER", "OPERATIONAL", "TECHNICAL"] as ClaimType[]).map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
        </select>
        <span style={{ fontSize: 11.5, color: "var(--studio-muted)" }}>Your P(true)</span>
        <input className="rm-rng" type="range" min={0} max={100} value={est} onChange={(e) => setEst(Number(e.target.value))} style={{ width: 120 }} />
        <span style={{ fontFamily: "var(--studio-mono)", fontSize: 12, minWidth: 38 }}>{est}%</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="rm-btn" style={btn} onClick={() => setOpen(false)}>Cancel</button>
          <button className="rm-btn" style={primaryBtn} onClick={add} disabled={!statement.trim() || busy}>{busy ? "Adding…" : "Add claim"}</button>
        </div>
      </div>
    </div>
  );
}

function CopilotButtons({ projectId, roomId, onChanged, onError }: { projectId: string; roomId: string; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [accepting, setAccepting] = useState<number | null>(null);

  async function propose() {
    if (!prompt.trim()) return;
    setBusy(true); setResult(null);
    try { setResult(await workgraphFetch<ProposeResult>(`/studio/rooms/${roomId}/copilot/propose`, { method: "POST", body: JSON.stringify({ prompt: prompt.trim() }) })); }
    catch (e) { onError(e instanceof Error ? e.message : "The AI peer could not respond (the model bridge may be down)."); }
    finally { setBusy(false); }
  }
  async function accept(c: Candidate, i: number) {
    if (!result) return;
    setAccepting(i);
    try { await workgraphFetch(`/studio/rooms/${roomId}/copilot/accept`, { method: "POST", body: JSON.stringify({ ...c, traceId: result.traceId }) }); setResult({ ...result, claims: result.claims.filter((_, j) => j !== i) }); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : "Could not accept the claim."); }
    finally { setAccepting(null); }
  }

  return (
    <>
      <button className="rm-btn" style={aiBtn} onClick={() => setOpen((v) => !v)}><Sparkles size={13} /> Propose framings</button>
      {open && (
        <div style={{ ...panel, position: "absolute", right: 0, marginTop: 40, width: 460, zIndex: 20, background: "var(--studio-panel-2)", border: "1px solid var(--studio-accent-line)", display: "grid", gap: 9, padding: 14, boxShadow: "var(--studio-shadow)" }}>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the room probe? e.g. 'Frame the problem behind our refund SLA — structurally distinct angles, each with its riskiest assumption.'" className="rm-input" style={{ ...input, minHeight: 58, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8 }}><button className="rm-btn" style={aiBtn} onClick={propose} disabled={!prompt.trim() || busy}>{busy ? "Thinking…" : "Propose"}</button><button className="rm-btn" style={btn} onClick={() => setOpen(false)}>Close</button></div>
          {result && <div style={{ display: "grid", gap: 8, maxHeight: 380, overflowY: "auto" }}>
            {result.reply && <p style={{ margin: 0, fontSize: 12, color: "var(--studio-muted)", lineHeight: 1.5 }}>{result.reply}</p>}
            {result.claims.map((c, i) => (
              <div key={i} style={{ ...panel, padding: 11 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                  {c.claimType && <span style={typeChip}>{c.claimType.toLowerCase()}</span>}
                  <span style={{ fontSize: 11, color: "var(--studio-accent-2)", fontFamily: "var(--studio-mono)" }}>AI P≈{Math.round(c.selfEstimate * 100)}%</span>
                  <button className="rm-btn" style={{ ...primaryBtn, marginLeft: "auto", padding: "4px 10px" }} onClick={() => accept(c, i)} disabled={accepting === i}>{accepting === i ? "…" : "Accept"}</button>
                </div>
                <div style={{ fontSize: 13, fontWeight: 550 }}>{c.statement}</div>
                {c.riskiestAssumption && <div style={{ fontSize: 11.5, color: "var(--studio-muted)", marginTop: 3 }}><b style={{ color: "var(--studio-ink-dim)" }}>Riskiest:</b> {c.riskiestAssumption}</div>}
              </div>
            ))}
          </div>}
        </div>
      )}
    </>
  );
}

function initials(id: string): string { return (id || "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?"; }

// ── styles ──
const muted: CSSProperties = { color: "var(--studio-muted)" };
const panel: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 11, padding: 14 };
const claimCard: CSSProperties = { background: "var(--studio-panel)", border: "1px solid var(--studio-line)", borderRadius: 11, padding: "15px 16px", boxShadow: "var(--studio-shadow)" };
const input: CSSProperties = { width: "100%", padding: "8px 11px", borderRadius: 8, fontSize: 13, border: "1px solid var(--studio-line-2)", background: "var(--studio-chrome)", color: "var(--studio-ink)", outline: "none" };
const chip: CSSProperties = { fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 5, border: "1px solid var(--studio-line)", color: "var(--studio-muted)", background: "var(--studio-panel-2)" };
const typeChip: CSSProperties = { ...chip, color: "var(--studio-accent-2)", borderColor: "var(--studio-accent-line)", background: "var(--studio-accent-soft)", textTransform: "lowercase" };
const btn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 500, borderRadius: 8, padding: "6px 11px", cursor: "pointer", border: "1px solid var(--studio-line)", background: "var(--studio-panel-2)", color: "var(--studio-ink)" };
const primaryBtn: CSSProperties = { ...btn, background: "var(--studio-accent)", color: "#fff", border: "1px solid transparent" };
const aiBtn: CSSProperties = { ...btn, color: "var(--studio-accent-2)", borderColor: "var(--studio-accent-line)", background: "var(--studio-accent-soft)" };
const submitBtn: CSSProperties = { fontSize: 12, fontWeight: 550, color: "var(--studio-accent-2)", background: "none", border: "1px solid var(--studio-accent-line)", borderRadius: 7, padding: "5px 12px", cursor: "pointer" };
const face: CSSProperties = { borderRadius: "50%", display: "grid", placeItems: "center", fontWeight: 650, color: "#fff", background: "var(--studio-accent)" };
const errorBanner: CSSProperties = { marginTop: 14, padding: "10px 13px", fontSize: 12.5, color: "var(--studio-bad)", background: "var(--studio-bad-soft)", border: "1px solid var(--studio-bad)", borderRadius: 9 };

function roomChip(active: boolean): CSSProperties {
  return { display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 500, cursor: "pointer",
    border: `1px solid ${active ? "var(--studio-line-2)" : "var(--studio-line)"}`, background: active ? "var(--studio-elev)" : "var(--studio-panel-2)", color: active ? "var(--studio-ink)" : "var(--studio-ink-dim)", boxShadow: active ? "var(--studio-shadow)" : "none" };
}

const CSS = `
.rm-claim, .rm-rchip, .rm-btn, .rm-submit, .rm-input { transition: border-color .15s ease, background-color .15s ease, color .15s ease, box-shadow .15s ease; }
.rm-claim:hover { border-color: var(--studio-line-2); }
.rm-rchip:hover { border-color: var(--studio-line-2); color: var(--studio-ink); }
.rm-btn:hover { border-color: var(--studio-line-2); }
.rm-submit:hover { background: var(--studio-accent-soft); }
.rm-input:focus { border-color: var(--studio-accent-line); }
.rm-rng { -webkit-appearance: none; appearance: none; flex: 1; height: 4px; border-radius: 3px; background: var(--studio-line-2); outline: none; }
.rm-rng::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--studio-ink); border: 2px solid var(--studio-panel); box-shadow: 0 1px 3px rgba(0,0,0,.4); cursor: pointer; }
.rm-rng::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--studio-ink); border: 2px solid var(--studio-panel); cursor: pointer; }
@media (max-width: 720px) { .rm-cbody { grid-template-columns: 1fr !important; } .rm-belief { border-left: none !important; border-top: 1px solid var(--studio-line); padding-left: 0 !important; padding-top: 14px; } }
@media (prefers-reduced-motion: reduce) { .rm-claim, .rm-rchip, .rm-btn, .rm-submit, .rm-input { transition: none; } }
`;
