"use client";
import { use, useState } from "react";
import useSWR from "swr";
import { agentApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Plus, Zap, RotateCcw, CheckCircle, XCircle } from "lucide-react";

export default function AgentDetailPage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = use(params);
  const { data: agent, mutate: mutateAgent } = useSWR(`agent-${uid}`, () => agentApi.get(uid));
  const { data: versionsData, mutate: mutateVersions } = useSWR(`versions-${uid}`, () => agentApi.listVersions(uid));
  const { data: candidatesData, mutate: mutateCandidates } = useSWR(`candidates-${uid}`, () => agentApi.listCandidates(uid));
  const { data: profilesData } = useSWR(`profiles-${uid}`, () => agentApi.listLearningProfileVersions(uid));

  const [tab, setTab] = useState<"versions" | "learning" | "audit">("versions");
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [vForm, setVForm] = useState({ system_prompt: "", change_reason: "" });
  const [creating, setCreating] = useState(false);

  const a = agent as Record<string, unknown> | undefined;

  async function handleCreateVersion(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await agentApi.createVersion(uid, vForm as unknown as Record<string, unknown>);
      setShowNewVersion(false);
      setVForm({ system_prompt: "", change_reason: "" });
      await mutateVersions();
    } finally {
      setCreating(false);
    }
  }

  async function handleActivate(version: number) {
    await agentApi.activateVersion(uid, version);
    await mutateVersions();
    await mutateAgent();
  }

  async function handleReview(id: string, decision: "accepted" | "rejected") {
    await agentApi.reviewCandidate(id, decision);
    await mutateCandidates();
  }

  const versions = versionsData?.versions ?? [];
  const candidates = candidatesData?.candidates ?? [];
  const profiles = profilesData?.versions ?? [];

  if (!a) return <div className="text-slate-500">Loading…</div>;

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold text-slate-900">{a.name as string}</h1>
          <StatusBadge value={a.status as string} />
          <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">{a.agent_type as string}</span>
        </div>
        <div className="font-mono text-xs text-slate-500">{a.agent_key as string}</div>
        {!!a.description && <p className="text-sm text-slate-600 mt-2">{a.description as string}</p>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(["versions", "learning", "audit"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t ? "border-singularity-600 text-singularity-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}>
            {t === "learning" ? "Learning" : t === "audit" ? "Audit" : "Versions"}
          </button>
        ))}
      </div>

      {/* Versions tab */}
      {tab === "versions" && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold text-slate-800">Agent Versions</h2>
            <button className="btn-primary" onClick={() => setShowNewVersion(true)}>
              <Plus size={15} /> New Version
            </button>
          </div>

          {showNewVersion && (
            <form onSubmit={handleCreateVersion} className="card p-5 mb-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">System Prompt *</label>
                <textarea rows={5} required
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
                  placeholder="You are the Developer Agent for..."
                  value={vForm.system_prompt} onChange={e => setVForm(f => ({ ...f, system_prompt: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Change Reason</label>
                <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  placeholder="Initial setup, prompt refinement, etc."
                  value={vForm.change_reason} onChange={e => setVForm(f => ({ ...f, change_reason: e.target.value }))} />
              </div>
              <div className="flex gap-3">
                <button type="submit" className="btn-primary" disabled={creating}>
                  {creating ? "Saving…" : "Save Version"}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setShowNewVersion(false)}>Cancel</button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {versions.map((v) => {
              const vr = v as Record<string, unknown>;
              return (
                <div key={vr.id as string} className="card p-4 flex items-start gap-4">
                  <div className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-1 rounded mt-0.5">
                    v{vr.version as number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusBadge value={vr.status as string} />
                      {!!vr.change_reason && <span className="text-xs text-slate-500">{vr.change_reason as string}</span>}
                    </div>
                    <p className="text-sm text-slate-700 line-clamp-2 font-mono">{vr.system_prompt as string}</p>
                  </div>
                  {vr.status !== "active" && (
                    <button onClick={() => handleActivate(vr.version as number)}
                      className="btn-secondary text-xs shrink-0" title="Activate this version">
                      <Zap size={14} /> Activate
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Learning tab */}
      {tab === "learning" && (
        <div className="space-y-6">
          <div>
            <h2 className="font-semibold text-slate-800 mb-3">Learning Candidates</h2>
            <div className="space-y-2">
              {candidates.map((c) => {
                const cr = c as Record<string, unknown>;
                return (
                  <div key={cr.id as string} className="card p-4 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{cr.candidate_type as string}</span>
                        <StatusBadge value={cr.status as string} />
                        <span className="text-xs text-slate-400">conf: {cr.confidence as number}</span>
                      </div>
                      <p className="text-sm text-slate-700">{cr.content as string}</p>
                    </div>
                    {cr.status === "pending" && (
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => handleReview(cr.id as string, "accepted")}
                          className="text-emerald-600 hover:text-emerald-700" title="Accept">
                          <CheckCircle size={18} />
                        </button>
                        <button onClick={() => handleReview(cr.id as string, "rejected")}
                          className="text-red-500 hover:text-red-600" title="Reject">
                          <XCircle size={18} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {candidates.length === 0 && <p className="text-slate-400 text-sm">No learning candidates.</p>}
            </div>
          </div>

          <div>
            <h2 className="font-semibold text-slate-800 mb-3">Learning Profile Versions</h2>
            <div className="space-y-2">
              {profiles.map((p) => {
                const pr = p as Record<string, unknown>;
                return (
                  <div key={pr.id as string} className="card p-4 flex items-start gap-3">
                    <div className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-1 rounded mt-0.5">
                      v{pr.version as number}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge value={pr.status as string} />
                        {!!pr.change_reason && <span className="text-xs text-slate-500">{pr.change_reason as string}</span>}
                      </div>
                      {!!pr.summary_text && <p className="text-sm text-slate-700">{pr.summary_text as string}</p>}
                    </div>
                    <button className="btn-secondary text-xs shrink-0" title="Rollback to this version">
                      <RotateCcw size={13} /> Rollback
                    </button>
                  </div>
                );
              })}
              {profiles.length === 0 && <p className="text-slate-400 text-sm">No learning profiles yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* Audit tab */}
      {tab === "audit" && <AuditPanel uid={uid} />}
    </div>
  );
}

function AuditPanel({ uid }: { uid: string }) {
  const { data } = useSWR(`audit-${uid}`, () => agentApi.audit(uid));
  const events = data?.events ?? [];
  return (
    <div>
      <h2 className="font-semibold text-slate-800 mb-3">Audit Events</h2>
      <div className="space-y-2">
        {events.map((e) => {
          const ev = e as Record<string, unknown>;
          return (
            <div key={ev.id as string} className="card p-3 flex items-center gap-3 text-sm">
              <span className="font-mono text-xs text-slate-500 shrink-0">
                {new Date(ev.created_at as string).toLocaleString()}
              </span>
              <span className="font-medium text-slate-800">{ev.event_type as string}</span>
            </div>
          );
        })}
        {events.length === 0 && <p className="text-slate-400 text-sm">No audit events.</p>}
      </div>
    </div>
  );
}
