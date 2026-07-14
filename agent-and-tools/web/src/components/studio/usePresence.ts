"use client";

import { useEffect, useState } from "react";
import { workgraphFetch } from "@/lib/workgraph";

/**
 * Live presence for a project. Heartbeats every 8s with the surface (tab) the user is on and stores
 * the returned live set — so everyone sees who else is here and what they're looking at. Best-effort:
 * network errors are swallowed, and a user simply ages out of the set (server TTL) after they leave.
 */
export type Present = { userId: string; displayName?: string; surface?: string; at: number };

const HEARTBEAT_MS = 8000;

export function usePresence(projectId: string, surface: string): Present[] {
  const [present, setPresent] = useState<Present[]>([]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function beat() {
      try {
        const res = await workgraphFetch<{ present: Present[] }>(`/studio/projects/${projectId}/presence`, {
          method: "POST",
          body: JSON.stringify({ surface }),
        });
        if (active) setPresent(Array.isArray(res.present) ? res.present : []);
      } catch {
        // presence is best-effort — ignore transient failures
      }
      if (active) timer = setTimeout(beat, HEARTBEAT_MS);
    }

    beat();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, surface]);

  return present;
}
