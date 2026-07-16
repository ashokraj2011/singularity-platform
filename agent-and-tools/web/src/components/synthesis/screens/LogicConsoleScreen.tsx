"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import {
  Binary,
  TriangleAlert,
  ShieldQuestion,
  ScatterChart,
  CheckCircle2,
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
  EmptyState,
  SynSkeleton,
  SynError,
  ConfidenceBar,
} from "@/components/synthesis/ui/kit";
import { useClaims, useProjectSpec } from "@/components/synthesis/hooks/useSynthesis";
import type { SynClaim } from "@/components/synthesis/types";

const CONTESTED_VAR = 0.05;
const LIKELY_FALSE = 0.35;

export function LogicConsoleScreen() {
  const pathname = usePathname() ?? "/synthesis/logic";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Logic Console" headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? (
        <LogicConsole projectId={projectId} />
      ) : (
        <NoProjectSelected surface="The Logic Console" />
      )}
    </SynthesisShell>
  );
}

function LogicConsole({ projectId }: { projectId: string }) {
  const claimsQ = useClaims(projectId, {}, { refreshInterval: 15000 });
  const specQ = useProjectSpec(projectId);

  const claims = claimsQ.data?.items ?? [];
  const requirements = specQ.data?.package?.requirements ?? [];

  const signals = useMemo(() => {
    const contested = claims.filter((c) => (c.disagreement ?? 0) > CONTESTED_VAR);
    const likelyFalse = claims.filter((c) => (c.mean ?? 0.5) < LIKELY_FALSE);
    const unbacked = claims.filter((c) => (c.estimateCount ?? 0) <= 1);
    const mustReqs = requirements.filter((r) => r.priority === "MUST");
    const mustNoCriteria = mustReqs.filter((r) => r.acceptanceCriteria.length === 0);
    return { contested, likelyFalse, unbacked, mustReqs, mustNoCriteria };
  }, [claims, requirements]);

  const loading = claimsQ.isLoading || specQ.isLoading;
  const error = claimsQ.error || specQ.error;
  const clean =
    signals.contested.length === 0 &&
    signals.likelyFalse.length === 0 &&
    signals.mustNoCriteria.length === 0;

  return (
    <div>
      <div className="mb-8">
        <MonoMeta className="block mb-1">Consistency &amp; conflict</MonoMeta>
        <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
          Logic Console
        </h1>
        <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
          Where the specification disagrees with itself. Contested claims, likely-false assumptions
          still in play, and MUST requirements without acceptance criteria all surface here.
        </p>
      </div>

      {error ? (
        <SynError message={`Could not load logic data: ${(error as Error).message}`} />
      ) : loading ? (
        <SynSkeleton rows={4} />
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Signal
              icon={ScatterChart}
              label="Contested"
              value={signals.contested.length}
              danger={signals.contested.length > 0}
            />
            <Signal
              icon={TriangleAlert}
              label="Likely false"
              value={signals.likelyFalse.length}
              danger={signals.likelyFalse.length > 0}
            />
            <Signal
              icon={ShieldQuestion}
              label="Unbacked"
              value={signals.unbacked.length}
            />
            <Signal
              icon={Binary}
              label="MUST w/o criteria"
              value={signals.mustNoCriteria.length}
              danger={signals.mustNoCriteria.length > 0}
            />
          </div>

          {clean ? (
            <SynCard className="p-6 flex items-center gap-3">
              <CheckCircle2 size={20} className="text-secondary" />
              <div>
                <div className="font-display font-semibold text-sm text-on-surface">
                  No consistency conflicts detected
                </div>
                <MonoMeta>
                  {claims.length} claims · {requirements.length} requirements analyzed
                </MonoMeta>
              </div>
            </SynCard>
          ) : (
            <div className="flex flex-col gap-8">
              <ConflictGroup
                title="Contested claims"
                caption="High disagreement across estimators — resolve before converging."
                claims={signals.contested}
                metric={(c) => `${(c.disagreement ?? 0).toFixed(3)} var`}
              />
              <ConflictGroup
                title="Likely-false assumptions still in play"
                caption="Posterior below 35% — either drop these or the requirements relying on them."
                claims={signals.likelyFalse}
                metric={(c) => `${Math.round((c.mean ?? 0) * 100)}%`}
              />
              {signals.mustNoCriteria.length > 0 ? (
                <div>
                  <div className="mb-3">
                    <span className="font-display font-semibold text-base text-on-surface">
                      MUST requirements without acceptance criteria
                    </span>
                    <p className="text-sm text-on-surface-variant mt-0.5">
                      A MUST with no way to verify it is a latent conflict.
                    </p>
                  </div>
                  <div className="flex flex-col gap-3">
                    {signals.mustNoCriteria.map((r) => (
                      <SynCard key={r.id} className="p-4 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <MonoMeta>{r.id}</MonoMeta>
                          <p className="text-sm text-on-surface mt-1">{r.statement}</p>
                        </div>
                        <SynChip tone="error" mono>
                          MUST
                        </SynChip>
                      </SynCard>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Signal({
  icon: Icon,
  label,
  value,
  danger,
}: {
  icon: typeof Binary;
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <SynCard className="p-5">
      <div className="flex items-center gap-2 text-on-surface-variant mb-3">
        <Icon size={16} strokeWidth={1.8} />
        <MonoMeta>{label}</MonoMeta>
      </div>
      <div
        className={[
          "font-display font-semibold text-3xl tabular-nums",
          danger ? "text-error" : "text-on-surface",
        ].join(" ")}
      >
        {value}
      </div>
    </SynCard>
  );
}

function ConflictGroup({
  title,
  caption,
  claims,
  metric,
}: {
  title: string;
  caption: string;
  claims: SynClaim[];
  metric: (c: SynClaim) => string;
}) {
  if (claims.length === 0) return null;
  return (
    <div>
      <div className="mb-3">
        <span className="font-display font-semibold text-base text-on-surface">{title}</span>
        <p className="text-sm text-on-surface-variant mt-0.5">{caption}</p>
      </div>
      <div className="flex flex-col gap-3">
        {claims.map((c) => (
          <SynCard key={c.id} className="p-4 flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-on-surface leading-snug">{c.statement}</p>
              <div className="mt-2 max-w-xs">
                <ConfidenceBar value={c.mean ?? 0.5} />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              {c.claimType ? <SynChip mono>{c.claimType}</SynChip> : null}
              <SynChip tone="error" icon={TriangleAlert}>
                {metric(c)}
              </SynChip>
            </div>
          </SynCard>
        ))}
      </div>
    </div>
  );
}
