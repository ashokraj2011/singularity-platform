"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  MessagesSquare,
  FlaskConical,
  Plus,
  Check,
  X,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { SynthesisShell } from "@/components/synthesis/SynthesisShell";
import {
  ProjectPicker,
  NoProjectSelected,
  useSelectedProjectId,
} from "@/components/synthesis/ProjectPicker";
import {
  SynCard,
  SynChip,
  MonoMeta,
  SynButton,
  EmptyState,
  SynSkeleton,
  SynError,
  ConfidenceBar,
} from "@/components/synthesis/ui/kit";
import { useClaims, useProbes } from "@/components/synthesis/hooks/useSynthesis";
import { workgraphFetch } from "@/lib/workgraph";
import type { SynClaim, SynProbe } from "@/components/synthesis/types";

export function AssumptionRoomScreen() {
  const pathname = usePathname() ?? "/synthesis/rooms";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Assumption Rooms" headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? (
        <AssumptionRoom projectId={projectId} />
      ) : (
        <NoProjectSelected surface="Assumption Rooms" />
      )}
    </SynthesisShell>
  );
}

function AssumptionRoom({ projectId }: { projectId: string }) {
  const claimsQ = useClaims(projectId, { contested: true }, { refreshInterval: 15000 });
  const claims = claimsQ.data?.items ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId && claims.length > 0) setActiveId(claims[0].id);
  }, [claims, activeId]);

  const active = claims.find((c) => c.id === activeId) ?? null;

  return (
    <div>
      <div className="mb-8">
        <MonoMeta className="block mb-1">Validation path</MonoMeta>
        <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
          Assumption Rooms
        </h1>
        <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
          Turn the riskiest assumptions into falsifiable probes. Resolve each with evidence and watch
          the claim&apos;s posterior move toward the truth.
        </p>
      </div>

      {claimsQ.error ? (
        <SynError message={`Could not load claims: ${(claimsQ.error as Error).message}`} />
      ) : claimsQ.isLoading ? (
        <SynSkeleton rows={4} />
      ) : claims.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No claims to validate yet"
          description="Capture claims on the Idea Wall or Discovery Board first — then bring the contested ones here."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
          <div className="flex flex-col gap-3">
            <MonoMeta>Most contested first</MonoMeta>
            {claims.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={[
                  "text-left rounded-xl border p-4 transition-all",
                  activeId === c.id
                    ? "border-secondary bg-secondary-container/40"
                    : "border-outline-variant bg-surface-container-lowest hover:border-secondary/60",
                ].join(" ")}
              >
                <p className="text-sm text-on-surface leading-snug line-clamp-2">{c.statement}</p>
                <div className="mt-2">
                  <ConfidenceBar value={c.mean ?? 0.5} />
                </div>
              </button>
            ))}
          </div>
          <div>{active ? <ProbePanel claim={active} onChanged={() => claimsQ.mutate()} /> : null}</div>
        </div>
      )}
    </div>
  );
}

function ProbePanel({ claim, onChanged }: { claim: SynClaim; onChanged: () => void }) {
  const probesQ = useProbes(claim.id, { refreshInterval: 12000 });
  const probes = probesQ.data?.items ?? [];
  const [adding, setAdding] = useState(false);
  const [risk, setRisk] = useState("");
  const [falsify, setFalsify] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!risk.trim() || !falsify.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await workgraphFetch(`/studio/claims/${claim.id}/probes`, {
        method: "POST",
        body: JSON.stringify({ riskiestAssumption: risk.trim(), falsification: falsify.trim() }),
      });
      setRisk("");
      setFalsify("");
      setAdding(false);
      await probesQ.mutate();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolve(probeId: string, supports: boolean) {
    try {
      await workgraphFetch(`/studio/probes/${probeId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ supports }),
      });
      await probesQ.mutate();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SynCard className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-on-surface font-medium leading-snug">{claim.statement}</p>
            {claim.riskiestAssumption ? (
              <p className="text-xs text-on-surface-variant italic mt-1.5">
                Riskiest assumption: {claim.riskiestAssumption}
              </p>
            ) : null}
          </div>
          {claim.claimType ? <SynChip mono>{claim.claimType}</SynChip> : null}
        </div>
        <div className="mt-4 max-w-sm">
          <ConfidenceBar value={claim.mean ?? 0.5} />
        </div>
      </SynCard>

      <div className="flex items-center justify-between">
        <span className="font-display font-semibold text-sm text-on-surface">
          Probes ({probes.length})
        </span>
        <SynButton icon={Plus} variant="secondary" onClick={() => setAdding((v) => !v)}>
          New probe
        </SynButton>
      </div>

      {adding ? (
        <SynCard className="p-5 flex flex-col gap-3">
          <label>
            <MonoMeta className="block mb-1.5">Riskiest assumption</MonoMeta>
            <input
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
              placeholder="What must be true for this claim to hold?"
              className="h-10 w-full px-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm focus:outline-none focus:border-secondary"
            />
          </label>
          <label>
            <MonoMeta className="block mb-1.5">Falsification test</MonoMeta>
            <input
              value={falsify}
              onChange={(e) => setFalsify(e.target.value)}
              placeholder="What experiment would prove it false?"
              className="h-10 w-full px-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm focus:outline-none focus:border-secondary"
            />
          </label>
          {err ? <SynError message={err} /> : null}
          <div className="flex justify-end gap-2">
            <SynButton variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </SynButton>
            <SynButton onClick={create} disabled={!risk.trim() || !falsify.trim() || busy}>
              {busy ? "Creating…" : "Create probe"}
            </SynButton>
          </div>
        </SynCard>
      ) : null}

      {probesQ.isLoading ? (
        <SynSkeleton rows={2} />
      ) : probes.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No probes yet"
          description="Design a falsifiable probe to reduce uncertainty on this claim."
        />
      ) : (
        probes.map((p) => <ProbeRow key={p.id} probe={p} onResolve={resolve} />)
      )}
    </div>
  );
}

function ProbeRow({
  probe,
  onResolve,
}: {
  probe: SynProbe;
  onResolve: (id: string, supports: boolean) => void;
}) {
  const open = (probe.status ?? "OPEN") === "OPEN";
  return (
    <SynCard className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-on-surface leading-snug">{probe.riskiestAssumption}</p>
          <p className="text-xs text-on-surface-variant mt-1">Falsify: {probe.falsification}</p>
          <div className="flex items-center gap-2 mt-2">
            {probe.tier ? <SynChip mono>{probe.tier}</SynChip> : null}
            <SynChip tone={open ? "neutral" : "secondary"} mono>
              {probe.status ?? "OPEN"}
            </SynChip>
            {typeof probe.eig === "number" ? <MonoMeta>EIG {probe.eig.toFixed(4)}</MonoMeta> : null}
          </div>
        </div>
        {open ? (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onResolve(probe.id, true)}
              title="Evidence supports"
              className="w-9 h-9 rounded-lg bg-secondary-container text-on-secondary-container flex items-center justify-center hover:opacity-80"
            >
              <ShieldCheck size={16} />
            </button>
            <button
              onClick={() => onResolve(probe.id, false)}
              title="Evidence refutes"
              className="w-9 h-9 rounded-lg bg-error-container text-on-error-container flex items-center justify-center hover:opacity-80"
            >
              <ShieldAlert size={16} />
            </button>
          </div>
        ) : (
          <div className="shrink-0">
            {probe.status === "RESOLVED" ? (
              <Check size={18} className="text-secondary" />
            ) : (
              <X size={18} className="text-on-surface-variant" />
            )}
          </div>
        )}
      </div>
    </SynCard>
  );
}
