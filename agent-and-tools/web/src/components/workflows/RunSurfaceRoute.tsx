"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { RunArtifactsPage } from "workgraph-web/features/runtime/RunArtifactsPage";
import { RunInsightsPage } from "workgraph-web/features/runtime/RunInsightsPage";
import { RunViewerPage } from "workgraph-web/features/runtime/RunViewerPage";

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

function RedirectToPlatform({ to }: { to: string }) {
  const location = useLocation();
  useEffect(() => {
    const next = `${to}${location.search}${location.hash}`;
    if (window.location.pathname !== to || window.location.search !== location.search || window.location.hash !== location.hash) {
      window.location.assign(next);
    }
  }, [location.hash, location.search, to]);
  return null;
}

function RedirectMissionControl() {
  const { id } = useParams<{ id: string }>();
  return <RedirectToPlatform to={`/runs/${id ?? ""}/insights`} />;
}

function RedirectPlay() {
  const { runId } = useParams<{ runId: string }>();
  return <RedirectToPlatform to={`/runs/${runId ?? ""}`} />;
}

export function RunSurfaceRoute() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/runs/:id" element={<RunViewerPage />} />
          <Route path="/runs/:id/artifacts" element={<RunArtifactsPage />} />
          <Route path="/runs/:id/insights" element={<RunInsightsPage />} />
          <Route path="/mission-control/:id" element={<RedirectMissionControl />} />
          <Route path="/play/:runId" element={<RedirectPlay />} />
          <Route path="*" element={<RedirectToPlatform to="/runs" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
