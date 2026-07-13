"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { apiPath, authHeaders, readResponseBody } from "@/lib/api";
import { PageHero, PageShell, StatusPill } from "@/components/ui/primitives";

type AccessResponse = {
  user_id?: string;
  tenant_id?: string;
  policy_version?: string;
  permissions?: string[];
};

export default function EffectiveAccessPage() {
  const [tenantId, setTenantId] = useState("default");
  const [data, setData] = useState<AccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiPath(`/api/authz/effective-access?tenant_id=${encodeURIComponent(tenantId || "default")}`), {
        headers: { ...authHeaders() },
      });
      const body = await readResponseBody(res);
      if (!res.ok) throw new Error(typeof body.parsed === "object" && body.parsed && "detail" in body.parsed ? String((body.parsed as { detail?: unknown }).detail) : body.raw || res.statusText);
      setData(body.parsed as AccessResponse);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Could not load effective access");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <PageShell>
      <PageHero
        eyebrow="IDENTITY / EFFECTIVE ACCESS"
        title="What can I do?"
        description="The permissions that apply to your signed-in identity in the selected tenant. Workflow actions still evaluate the owning capability and resource grant at request time."
        icon={ShieldCheck}
      />
      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,1.3fr)]">
        <section className="card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ShieldCheck size={18} className="text-emerald-700" /> Access context</div>
          <label className="mt-4 grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            Tenant ID
            <input className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-900" value={tenantId} onChange={(event) => setTenantId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} />
          </label>
          <button type="button" className="btn-primary mt-3" onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Refresh access"}</button>
          {error && <div className="mt-4 flex gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><ShieldAlert size={17} />{error}</div>}
          {data && <div className="mt-4 grid gap-2 text-sm text-slate-600"><div><strong>User:</strong> {data.user_id ?? "Current session"}</div><div><strong>Tenant:</strong> {data.tenant_id ?? tenantId}</div><div><strong>Policy:</strong> {data.policy_version ?? "unknown"}</div></div>}
        </section>
        <section className="card p-5">
          <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 size={18} className="text-emerald-700" /> Effective permissions</div><StatusPill state={data ? "ready" : loading ? "waiting" : "blocked"} /></div>
          {!data && !loading && <p className="mt-4 text-sm text-slate-600">No access decision is available. Resolve the tenant or session error and refresh.</p>}
          {loading && <p className="mt-4 text-sm text-slate-500">Evaluating IAM access…</p>}
          {data && <div className="mt-4 flex flex-wrap gap-2">{(data.permissions ?? []).map(permission => <span key={permission} className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{permission}</span>)}</div>}
        </section>
      </div>
    </PageShell>
  );
}
