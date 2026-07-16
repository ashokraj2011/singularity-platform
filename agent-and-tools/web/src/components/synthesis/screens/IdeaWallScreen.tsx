"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Lightbulb,
  Plus,
  Sparkles,
  Loader2,
  Users,
  Cpu,
  FlaskConical,
  Building2,
  LayoutGrid,
  ListChecks,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import {
  useRooms,
  useClaims,
  createRoom,
  createClaim,
  proposeClaims,
} from "@/components/synthesis/hooks/useSynthesis";
import type { ClaimType, SynClaim } from "@/components/synthesis/types";
import { IdeaBoardWorkspace } from "@/components/synthesis/IdeaBoardWorkspace";

const CLAIM_TYPES: { key: ClaimType; label: string; icon: LucideIcon }[] = [
  { key: "MARKET", label: "Market", icon: Building2 },
  { key: "USER", label: "User", icon: Users },
  { key: "OPERATIONAL", label: "Operational", icon: FlaskConical },
  { key: "TECHNICAL", label: "Technical", icon: Cpu },
];

const IDEA_WALL_ROOM = "Idea Board";

export function IdeaWallScreen() {
  const pathname = usePathname() ?? "/synthesis/ideas";
  const projectId = useSelectedProjectId();
  const [view, setView] = useState<"board" | "claims">("board");

  return (
    <SynthesisShell
      title="Idea Board"
      fullBleed={view === "board"}
      headerActions={(
        <>
          <div className="flex h-9 items-center rounded-lg border border-outline-variant bg-surface-container-low p-1" aria-label="Idea workspace view">
            <button type="button" onClick={() => setView("board")} className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold ${view === "board" ? "bg-surface text-on-surface shadow-sm" : "text-on-surface-variant"}`}><LayoutGrid size={14} /> Board</button>
            <button type="button" onClick={() => setView("claims")} className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold ${view === "claims" ? "bg-surface text-on-surface shadow-sm" : "text-on-surface-variant"}`}><ListChecks size={14} /> Claims</button>
          </div>
          <ProjectPicker pathname={pathname} />
        </>
      )}
    >
      {projectId
        ? view === "board" ? <IdeaBoardWorkspace projectId={projectId} /> : <ClaimsView projectId={projectId} />
        : <NoProjectSelected surface="The Idea Board" />}
    </SynthesisShell>
  );
}

function ClaimsView({ projectId }: { projectId: string }) {
  const roomsQ = useRooms(projectId);
  const claimsQ = useClaims(projectId, {}, { refreshInterval: 15000 });
  const [draft, setDraft] = useState("");
  const [claimType, setClaimType] = useState<ClaimType>("USER");
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const claims = claimsQ.data?.items ?? [];
  const rooms = roomsQ.data?.items ?? [];

  const grouped = useMemo(() => {
    const map = new Map<ClaimType, SynClaim[]>();
    for (const t of CLAIM_TYPES) map.set(t.key, []);
    for (const c of claims) {
      const key = (c.claimType as ClaimType) ?? "USER";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return map;
  }, [claims]);

  async function ensureRoom(): Promise<string> {
    const existing = rooms.find((r) => r.title === IDEA_WALL_ROOM);
    if (existing) return existing.id;
    const room = await createRoom(projectId, IDEA_WALL_ROOM);
    await roomsQ.mutate();
    return room.id;
  }

  async function capture() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const roomId = await ensureRoom();
      await createClaim(projectId, {
        roomId,
        statement: draft.trim(),
        claimType,
        initialEstimate: 0.5,
      });
      setDraft("");
      await claimsQ.mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function aiExpand() {
    if (parsing) return;
    setParsing(true);
    setErr(null);
    try {
      const roomId = await ensureRoom();
      const seed =
        draft.trim() ||
        "Propose the riskiest market, user, operational, and technical assumptions for this initiative.";
      await proposeClaims(roomId, seed);
      setDraft("");
      await claimsQ.mutate();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setParsing(false);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <MonoMeta className="block mb-1">Capture · Parse · Cluster</MonoMeta>
          <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
            Governed claims
          </h1>
          <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
            Promote selected notes from the board or capture a claim directly. Claims carry confidence,
            provenance, and validation state into discovery and specification.
          </p>
        </div>
        <MonoMeta>{claims.length} claims</MonoMeta>
      </div>

      {/* Composer */}
      <SynCard className="p-5 mb-8">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Capture an idea or assumption… e.g. 'Enterprise buyers will pay for SSO'"
          className="w-full resize-none bg-transparent text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none"
        />
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-outline-variant/60">
          <div className="flex items-center gap-1.5">
            {CLAIM_TYPES.map((t) => (
              <button
                key={t.key}
                onClick={() => setClaimType(t.key)}
                className={[
                  "px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                  claimType === t.key
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-on-surface-variant hover:bg-surface-container-high",
                ].join(" ")}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <SynButton
              variant="secondary"
              icon={parsing ? Loader2 : Sparkles}
              onClick={aiExpand}
              disabled={parsing}
            >
              {parsing ? "Parsing…" : "Expand with AI"}
            </SynButton>
            <SynButton icon={Plus} onClick={capture} disabled={!draft.trim() || busy}>
              {busy ? "Adding…" : "Add claim"}
            </SynButton>
          </div>
        </div>
      </SynCard>

      {err ? (
        <div className="mb-6">
          <SynError message={err} />
        </div>
      ) : null}

      {claimsQ.error ? (
        <SynError message={`Could not load claims: ${(claimsQ.error as Error).message}`} />
      ) : claimsQ.isLoading ? (
        <SynSkeleton rows={4} />
      ) : claims.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="The wall is empty"
          description="Capture your first idea above, or let the copilot propose the riskiest assumptions to get started."
          action={
            <SynButton icon={Sparkles} variant="secondary" onClick={aiExpand} disabled={parsing}>
              {parsing ? "Parsing…" : "Propose starter claims"}
            </SynButton>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 items-start">
          {CLAIM_TYPES.map((t) => (
            <ClaimColumn key={t.key} type={t} claims={grouped.get(t.key) ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimColumn({
  type,
  claims,
}: {
  type: { key: ClaimType; label: string; icon: LucideIcon };
  claims: SynClaim[];
}) {
  const Icon = type.icon;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <Icon size={15} className="text-on-surface-variant" strokeWidth={1.8} />
        <span className="font-display font-semibold text-sm text-on-surface">{type.label}</span>
        <span className="font-mono text-[11px] text-on-surface-variant">{claims.length}</span>
      </div>
      {claims.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/70 py-8 text-center text-xs text-on-surface-variant/70">
          No {type.label.toLowerCase()} claims yet
        </div>
      ) : (
        claims.map((c) => <IdeaCard key={c.id} claim={c} />)
      )}
    </div>
  );
}

function IdeaCard({ claim }: { claim: SynClaim }) {
  const contested = (claim.disagreement ?? 0) > 0.05;
  return (
    <SynCard className="p-4 flex flex-col gap-3">
      <p className="text-sm text-on-surface leading-snug">{claim.statement}</p>
      {claim.riskiestAssumption ? (
        <p className="text-xs text-on-surface-variant italic border-l-2 border-outline-variant pl-2">
          {claim.riskiestAssumption}
        </p>
      ) : null}
      <ConfidenceBar value={claim.mean ?? 0.5} />
      <div className="flex items-center justify-between">
        <MonoMeta>{claim.estimateCount ?? 0} est.</MonoMeta>
        {contested ? <SynChip tone="error" mono>Contested</SynChip> : null}
      </div>
    </SynCard>
  );
}
