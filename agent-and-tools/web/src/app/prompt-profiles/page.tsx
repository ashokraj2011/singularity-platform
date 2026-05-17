"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  ChevronRight,
  Layers,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { runtimeApi } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";

const SCOPE_TYPES = ["PLATFORM", "AGENT_TEMPLATE", "AGENT_BINDING", "CAPABILITY", "WORKFLOW", "WORKFLOW_PHASE"];

function scopeLabel(scope: unknown) {
  return String(scope || "AGENT_TEMPLATE").replace(/_/g, " ").toLowerCase();
}

function profileIntent(scope: unknown) {
  switch (scope) {
    case "PLATFORM":
      return "Shared baseline behavior";
    case "CAPABILITY":
      return "Capability-specific behavior";
    case "AGENT_BINDING":
      return "Runtime binding overlay";
    case "WORKFLOW":
    case "WORKFLOW_PHASE":
      return "Workflow-stage guidance";
    default:
      return "Agent template behavior";
  }
}

export default function PromptProfilesPage() {
  const { data, error, isLoading, mutate } = useSWR("runtime-profiles", () => runtimeApi.listProfiles());
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", ownerScopeType: "AGENT_TEMPLATE" });
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await runtimeApi.createProfile(form as never);
      setShowCreate(false);
      setForm({ name: "", description: "", ownerScopeType: "AGENT_TEMPLATE" });
      await mutate();
    } finally {
      setCreating(false);
    }
  }

  const items = (data ?? []) as Record<string, unknown>[];
  const totalLayers = items.reduce((sum, p) => sum + ((p.layers as unknown[] | undefined)?.length ?? 0), 0);
  const activeProfiles = items.filter(p => String(p.status ?? "").toUpperCase() === "ACTIVE").length;

  return (
    <div className="space-y-6">
      <div className="section-card overflow-hidden">
        <div className="p-6 border-b border-slate-200 bg-gradient-to-br from-white to-emerald-50/50">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-700">
                <Brain size={14} />
                Agent Behavior Profiles
              </div>
              <h1 className="mt-4 text-3xl font-bold text-slate-950">Reusable behavior presets for agents</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Profiles hold the human-authored instructions an agent starts with. Singularity then adds capability context,
                tools, memory, task context, and evidence at runtime so every execution stays explainable.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link className="btn-secondary bg-white" href="/prompt-workbench">
                <Sparkles size={16} />
                Open in Prompt Workbench
              </Link>
              <button className="btn-primary" onClick={() => setShowCreate(true)}>
                <Plus size={16} />
                New Behavior Profile
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-px bg-slate-200 md:grid-cols-3">
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Profiles</div>
            <div className="mt-2 text-2xl font-bold text-slate-950">{items.length}</div>
            <p className="mt-1 text-xs text-slate-500">Behavior presets available to agents.</p>
          </div>
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active</div>
            <div className="mt-2 text-2xl font-bold text-emerald-700">{activeProfiles}</div>
            <p className="mt-1 text-xs text-slate-500">Ready for agent templates or bindings.</p>
          </div>
          <div className="bg-white p-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Instruction Blocks</div>
            <div className="mt-2 text-2xl font-bold text-slate-950">{totalLayers}</div>
            <p className="mt-1 text-xs text-slate-500">Human-authored layers attached to profiles.</p>
          </div>
        </div>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="card p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Create behavior profile</h2>
            <p className="mt-1 text-sm text-slate-500">
              Start with a reusable preset. Runtime context is still added automatically during execution.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Profile name *</label>
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                required
                placeholder="Architect behavior, QA reviewer, Code planner"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Used by</label>
              <select
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={form.ownerScopeType}
                onChange={e => setForm(f => ({ ...f, ownerScopeType: e.target.value }))}
              >
                {SCOPE_TYPES.map(s => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <input
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              placeholder="What should this preset make the agent consistently do?"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={creating}>{creating ? "Creating..." : "Create Profile"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      {error && (
        <div className="card border-red-200 bg-red-50 p-5 text-red-800">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">Prompt profile service is not responding.</p>
              <p className="mt-1 text-sm text-red-700">
                The behavior-profile UI could not load data from prompt-composer. Existing runs keep their stored prompt assemblies.
              </p>
            </div>
            <button className="btn-secondary bg-white" onClick={() => mutate()}>
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="grid gap-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="h-4 w-48 rounded bg-slate-200" />
              <div className="mt-3 h-3 w-3/4 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map(p => {
            const layerCount = (p.layers as unknown[] | undefined)?.length ?? 0;
            return (
              <Link
                key={p.id as string}
                href={`/prompt-profiles/${p.id}`}
                className="card group flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-lg"
              >
                <div className="flex items-start gap-4">
                  <div className="rounded-xl bg-emerald-50 p-3 text-emerald-700">
                    <Layers size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-950">{p.name as string}</span>
                      <StatusBadge value={p.status as string} />
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      {(p.description as string | undefined) || "Reusable instructions for consistent agent behavior."}
                    </p>
                  </div>
                  <ChevronRight size={16} className="mt-2 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-emerald-700" />
                </div>

                <div className="mt-5 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">{profileIntent(p.ownerScopeType)}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{scopeLabel(p.ownerScopeType)}</span>
                  <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-indigo-700">{layerCount} instruction blocks</span>
                </div>

                <div className="mt-5 grid gap-2 border-t border-slate-100 pt-4 text-xs text-slate-500 sm:grid-cols-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={14} className="text-emerald-600" />
                    Human-authored
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowRight size={14} className="text-slate-400" />
                    Runtime context
                  </div>
                  <div className="flex items-center gap-2">
                    <Brain size={14} className="text-indigo-600" />
                    Auditable stack
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="card p-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
            <Layers size={30} />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">No behavior profiles yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
            Create a profile to define reusable agent behavior. You can attach instruction blocks now and inspect
            runtime-added context later from prompt assemblies.
          </p>
          <button className="btn-primary mx-auto mt-5" onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            Create First Profile
          </button>
        </div>
      )}
    </div>
  );
}
