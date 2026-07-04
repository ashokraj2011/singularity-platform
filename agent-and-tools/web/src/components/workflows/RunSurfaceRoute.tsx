"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunArtifactsPage } from "workgraph-web/features/runtime/RunArtifactsPage";
import { RunInsightsPage } from "workgraph-web/features/runtime/RunInsightsPage";
import { RunViewerPage } from "workgraph-web/features/runtime/RunViewerPage";
import { WorkgraphSurfaceBoundary } from "@/components/workflows/WorkgraphSurfaceBoundary";

// Mounted at the Next routes /runs/[id], /runs/[id]/artifacts, /runs/[id]/insights.
// Picks the page from the pathname (each page reads the run id via Next useParams).
// The old /mission-control/:id and /play/:runId redirects are now handled by the
// redirect table in next.config.mjs, so no react-router is needed here.

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function RunSurfaceRoute() {
  const queryClient = useMemo(createQueryClient, []);
  const pathname = usePathname() ?? "";
  const Page = pathname.endsWith("/artifacts")
    ? RunArtifactsPage
    : pathname.endsWith("/insights")
      ? RunInsightsPage
      : RunViewerPage;

  return (
    <QueryClientProvider client={queryClient}>
      <WorkgraphSurfaceBoundary surfaceLabel="Run cockpit">
        <Page />
      </WorkgraphSurfaceBoundary>
    </QueryClientProvider>
  );
}
