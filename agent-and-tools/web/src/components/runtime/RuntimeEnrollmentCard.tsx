"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Laptop, ShieldCheck } from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody } from "@/lib/api";
import { CopyButton } from "@/components/ui/CopyButton";

type Enrollment = {
  code: string;
  runtime_name: string;
  runtime_scope: string;
  expires_at: string;
  token_ttl_days: number;
};

function localDefaultContextUrl(): string {
  if (typeof window === "undefined") return "http://localhost:8000";
  const url = new URL(window.location.origin);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") url.port = "8000";
  return url.toString().replace(/\/$/, "");
}

export function RuntimeEnrollmentCard() {
  const [runtimeName, setRuntimeName] = useState("My Singularity Runtime");
  const [scope, setScope] = useState("user");
  const [tenantId, setTenantId] = useState("");
  const [contextUrl, setContextUrl] = useState(localDefaultContextUrl);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContextUrl(localDefaultContextUrl());
  }, []);

  const enrollCommand = useMemo(() => {
    if (!enrollment) return "";
    return `singularity-runtime enroll --url ${typeof window === "undefined" ? "https://platform.example" : window.location.origin} --code ${enrollment.code} --context-fabric-url ${contextUrl}`;
  }, [contextUrl, enrollment]);

  async function createEnrollment() {
    setBusy(true);
    setError(null);
    setEnrollment(null);
    try {
      const res = await fetch(apiPath("/api/runtime-enrollments"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          runtime_name: runtimeName.trim() || "Singularity Runtime",
          runtime_scope: scope,
          tenant_id: scope === "user" ? undefined : tenantId.trim() || undefined,
          ttl_minutes: 10,
          token_ttl_days: 90,
          allowed_frame_types: ["tool-run", "model-run", "code-context", "source-tree", "source-file", "work-finish-branch", "worktree-write-file", "invoke"],
          capability_tags: ["mcp", "tools", "llm"],
        }),
        cache: "no-store",
      });
      const { raw, parsed, parseError } = await readResponseBody(res);
      assertValidApiResponse("/api/runtime-enrollments", raw, parseError);
      if (!res.ok) throw new Error(typeof parsed === "object" && parsed && "detail" in parsed ? String(parsed.detail) : "Could not create runtime enrollment.");
      setEnrollment(parsed as Enrollment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create runtime enrollment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-white p-2 text-emerald-700 shadow-sm"><Laptop size={18} /></span>
        <div>
          <div className="text-sm font-black text-slate-950">Enroll a local runtime</div>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Generate a one-time code for MCP + local LLM Gateway. The CLI exchanges it once and stores the runtime token in the OS credential store.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="label-xs">Runtime name</span>
          <input className="control mt-2" value={runtimeName} onChange={(event) => setRuntimeName(event.target.value)} placeholder="Ashok's Mac" />
        </label>
        <label className="block">
          <span className="label-xs">Runtime scope</span>
          <select className="control mt-2" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="user">Personal: my runs only</option>
            <option value="tenant">Tenant: admin-managed</option>
            <option value="shared">Shared: admin-managed</option>
          </select>
        </label>
        <label className="block md:col-span-1">
          <span className="label-xs">Context Fabric URL</span>
          <input className="control mt-2" value={contextUrl} onChange={(event) => setContextUrl(event.target.value)} placeholder="https://context.example" />
        </label>
        {scope !== "user" && (
          <label className="block md:col-span-1">
            <span className="label-xs">Tenant ID</span>
            <input className="control mt-2" value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="Tenant UUID or key" required />
          </label>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" onClick={() => void createEnrollment()} disabled={busy}>
          <KeyRound size={14} /> {busy ? "Creating code..." : "Create one-time code"}
        </button>
        <span className="inline-flex items-center gap-1 text-xs text-slate-600"><ShieldCheck size={14} /> expires in 10 minutes · token lasts 90 days</span>
      </div>

      {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">{error}</div>}

      {enrollment && (
        <div className="mt-4 space-y-3 rounded-lg border border-emerald-300 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="label-xs">One-time enrollment code</div>
              <div className="mt-1 font-mono text-lg font-black tracking-[0.12em] text-slate-950">{enrollment.code}</div>
              <div className="mt-1 text-xs text-slate-500">Copy it now. It cannot be displayed again after the exchange.</div>
            </div>
            <CopyButton text={enrollment.code} label="Copy code" className="text-slate-500 hover:bg-slate-100 hover:text-slate-900" />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500"><Copy size={13} /> Run on the runtime host</div>
            <div className="flex items-start gap-2 rounded-md bg-slate-950 p-3 text-xs text-slate-100">
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-all leading-5">{enrollCommand}</code>
              <CopyButton text={enrollCommand} />
            </div>
            <div className="mt-2 text-xs leading-5 text-slate-500">Then run <code>singularity-runtime configure</code> for GitHub/Copilot and provider keys, followed by <code>singularity-runtime start</code>.</div>
          </div>
        </div>
      )}
    </div>
  );
}
