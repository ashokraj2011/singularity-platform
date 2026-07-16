"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Network, Plus, TriangleAlert, CheckCircle2, Radar } from "lucide-react";
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
  useConvergence,
  createRoom,
} from "@/components/synthesis/hooks/useSynthesis";
import type { SynClaim, SynRoom } from "@/components/synthesis/types";

export function DiscoveryBoardScreen() {
  const pathname = usePathname() ?? "/synthesis/discovery";
  const projectId = useSelectedProjectId();
  return (
    <SynthesisShell title="Discovery Board" headerActions={<ProjectPicker pathname={pathname} />}>
      {projectId ? (
        <DiscoveryBoard projectId={projectId} />
      ) : (
        <NoProjectSelected surface="The Discovery Board" />
      )}
    </SynthesisShell>
  );
}

function DiscoveryBoard({ projectId }: { projectId: string }) {
  const roomsQ = useRooms(projectId, { refreshInterval: 20000 });
  const rooms = roomsQ.data?.items ?? [];
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [newRoom, setNewRoom] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!activeRoom && rooms.length > 0) setActiveRoom(rooms[0].id);
  }, [rooms, activeRoom]);

  async function addRoom() {
    if (!newRoom.trim() || creating) return;
    setCreating(true);
    try {
      const room = await createRoom(projectId, newRoom.trim());
      setNewRoom("");
      await roomsQ.mutate();
      setActiveRoom(room.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <MonoMeta className="block mb-1">Reduce the unknowns</MonoMeta>
          <h1 className="font-display font-semibold text-2xl text-on-surface tracking-tight">
            Discovery Board
          </h1>
          <p className="mt-1.5 text-sm text-on-surface-variant max-w-2xl">
            Rooms group the claims under investigation. Variance across estimators locates ignorance —
            the most contested claims rise to the top so you know what to probe next.
          </p>
        </div>
      </div>

      {roomsQ.error ? (
        <SynError message={`Could not load rooms: ${(roomsQ.error as Error).message}`} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
          {/* Rooms rail */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <span className="font-display font-semibold text-sm text-on-surface">Rooms</span>
              <button
                onClick={() => setCreating((v) => !v)}
                className="text-on-surface-variant hover:text-on-surface p-1 rounded-full hover:bg-surface-container-high"
                aria-label="Add room"
              >
                <Plus size={16} />
              </button>
            </div>
            {creating ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newRoom}
                  onChange={(e) => setNewRoom(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addRoom()}
                  placeholder="Room title"
                  className="h-9 flex-1 px-3 rounded-lg bg-surface-container-low border border-outline-variant text-sm focus:outline-none focus:border-secondary"
                />
                <SynButton onClick={addRoom} disabled={!newRoom.trim()}>
                  Add
                </SynButton>
              </div>
            ) : null}
            {roomsQ.isLoading ? (
              <SynSkeleton rows={3} />
            ) : rooms.length === 0 ? (
              <div className="rounded-xl border border-dashed border-outline-variant/70 py-8 text-center text-xs text-on-surface-variant/70">
                No rooms yet
              </div>
            ) : (
              rooms.map((r) => (
                <RoomRailItem
                  key={r.id}
                  room={r}
                  active={activeRoom === r.id}
                  onClick={() => setActiveRoom(r.id)}
                />
              ))
            )}
          </div>

          {/* Board */}
          <div>
            {activeRoom ? (
              <RoomBoard projectId={projectId} roomId={activeRoom} />
            ) : (
              <EmptyState
                icon={Network}
                title="No room selected"
                description="Create or select a room to see the claims under investigation."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RoomRailItem({
  room,
  active,
  onClick,
}: {
  room: SynRoom;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "text-left rounded-xl border p-4 transition-all",
        active
          ? "border-secondary bg-secondary-container/40"
          : "border-outline-variant bg-surface-container-lowest hover:border-secondary/60",
      ].join(" ")}
    >
      <div className="font-medium text-sm text-on-surface truncate">{room.title}</div>
      <div className="flex items-center gap-2 mt-1.5">
        <MonoMeta>{room.claimCount ?? 0} claims</MonoMeta>
        {room.state ? <SynChip mono>{room.state}</SynChip> : null}
      </div>
    </button>
  );
}

function RoomBoard({ projectId, roomId }: { projectId: string; roomId: string }) {
  const claimsQ = useClaims(projectId, { roomId, contested: true }, { refreshInterval: 12000 });
  const convQ = useConvergence(roomId);
  const claims = claimsQ.data?.items ?? [];
  const conv = convQ.data;

  return (
    <div className="flex flex-col gap-5">
      {/* Convergence banner */}
      <SynCard className="p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={[
              "w-10 h-10 rounded-xl flex items-center justify-center",
              conv?.converged
                ? "bg-secondary-container text-on-secondary-container"
                : "bg-surface-container-high text-on-surface-variant",
            ].join(" ")}
          >
            {conv?.converged ? <CheckCircle2 size={20} /> : <Radar size={20} />}
          </div>
          <div>
            <div className="font-display font-semibold text-sm text-on-surface">
              {conv?.converged ? "Converged" : "Still learning"}
            </div>
            <MonoMeta>{conv?.openProbes ?? 0} open probes</MonoMeta>
          </div>
        </div>
        <div className="text-right">
          <MonoMeta className="block">Best info gain / hr</MonoMeta>
          <span className="font-mono text-sm text-on-surface tabular-nums">
            {conv ? conv.bestGainPerHour.toFixed(4) : "—"}
          </span>
        </div>
      </SynCard>

      {claimsQ.error ? (
        <SynError message={`Could not load claims: ${(claimsQ.error as Error).message}`} />
      ) : claimsQ.isLoading ? (
        <SynSkeleton rows={4} />
      ) : claims.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No claims in this room"
          description="Add claims from the Idea Wall, or use the room copilot to propose the riskiest assumptions."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <MonoMeta>Ranked by disagreement — most contested first</MonoMeta>
          {claims.map((c, i) => (
            <ContestedClaimRow key={c.id} claim={c} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ContestedClaimRow({ claim, rank }: { claim: SynClaim; rank: number }) {
  const contested = (claim.disagreement ?? 0) > 0.05;
  return (
    <SynCard className="p-4 flex items-start gap-4">
      <div className="font-mono text-xs text-on-surface-variant pt-0.5 w-6 text-right shrink-0">
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-on-surface leading-snug">{claim.statement}</p>
        {claim.riskiestAssumption ? (
          <p className="text-xs text-on-surface-variant italic mt-1">
            Riskiest: {claim.riskiestAssumption}
          </p>
        ) : null}
        <div className="mt-2.5 max-w-xs">
          <ConfidenceBar value={claim.mean ?? 0.5} />
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        {claim.claimType ? <SynChip mono>{claim.claimType}</SynChip> : null}
        {contested ? (
          <SynChip tone="error" icon={TriangleAlert}>
            {(claim.disagreement ?? 0).toFixed(3)}
          </SynChip>
        ) : (
          <MonoMeta>{(claim.disagreement ?? 0).toFixed(3)} var</MonoMeta>
        )}
      </div>
    </SynCard>
  );
}
