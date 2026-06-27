"use client";

import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "blueprint-workbench/App";
import { LoopTheater } from "blueprint-workbench/loop-theater/LoopTheater";
import "blueprint-workbench/styles.css";

// In-process mount of the blue Blueprint Workbench cockpit (slice 2 of the
// single-origin consolidation — replaces the standalone Vite app on :5176).
// Replicates blueprint-workbench/src/main.tsx: the same QueryClient retry/
// refetch policy and the ?theater bootstrap switch, rendered inside platform-
// web's Next /workbench route. Loaded via next/dynamic({ ssr: false }) by the
// page — it reads window/localStorage and must run client-only.

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Failed to fetch|NetworkError|ERR_NETWORK_IO_SUSPENDED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Load failed/i.test(err.message || "");
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => (isTransientNetworkError(error) ? failureCount < 3 : failureCount < 1),
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnReconnect: "always",
        refetchOnWindowFocus: "always",
        staleTime: 20_000,
      },
      mutations: {
        retry: (failureCount, error) => (isTransientNetworkError(error) ? failureCount < 1 : false),
        retryDelay: 1500,
      },
    },
  });
}

export default function WorkbenchCockpit() {
  const queryClient = useMemo(createQueryClient, []);
  // ?theater=<traceIdPrefix> mounts the replay theater instead of the cockpit
  // (mirrors main.tsx bootstrap()). Client-only, so window is available.
  const theater = new URLSearchParams(window.location.search).get("theater");
  return (
    <QueryClientProvider client={queryClient}>
      {theater ? <LoopTheater traceIdPrefix={theater} standalone /> : <App />}
    </QueryClientProvider>
  );
}
