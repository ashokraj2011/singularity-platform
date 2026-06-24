"use client";

import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ArtifactDesignerPage } from "workgraph-web/features/artifact/ArtifactDesignerPage";
import { ArtifactEditorPage } from "workgraph-web/features/artifact/ArtifactEditorPage";
import { CurationPage } from "workgraph-web/features/audit/CurationPage";
import { ConnectorsPage } from "workgraph-web/features/connectors/ConnectorsPage";
import { TeamVariablesPage } from "workgraph-web/features/identity/TeamVariablesPage";
import { InboxPage } from "workgraph-web/features/runtime/InboxPage";
import { ArtifactsExplorerPage } from "workgraph-web/features/runtime/ArtifactsExplorerPage";
import { HistoryPage } from "workgraph-web/features/runtime/HistoryPage";
import { RunWorkflowPage } from "workgraph-web/features/runtime/RunWorkflowPage";
import { RunsDashboardPage } from "workgraph-web/features/runtime/RunsDashboardPage";
import { RunArtifactsPage } from "workgraph-web/features/runtime/RunArtifactsPage";
import { RunInsightsPage } from "workgraph-web/features/runtime/RunInsightsPage";
import { RunPlayerEntry, RunPlayerPage } from "workgraph-web/features/runtime/RunPlayerPage";
import { RunViewerPage } from "workgraph-web/features/runtime/RunViewerPage";
import { WorkItemsPage } from "workgraph-web/features/runtime/WorkItemsPage";
import { WorkDetailPage } from "workgraph-web/features/runtime/WorkDetailPage";
import { MetadataRegistryPage } from "workgraph-web/features/metadata/MetadataRegistryPage";
import { PlannerPage } from "workgraph-web/features/planner/PlannerPage";
import { CustomNodeTypesPage } from "workgraph-web/features/workflow/CustomNodeTypesPage";
import { WorkflowStudioPage } from "workgraph-web/features/workflow/WorkflowStudioPage";
import { WorkflowsListPage } from "workgraph-web/features/workflow/WorkflowsListPage";

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

function LegacyWorkgraphRouter({ initialEntry }: { initialEntry: string }) {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/" element={<WorkflowsListPage />} />
          <Route path="/templates" element={<WorkflowsListPage />} />
          <Route path="/workflows" element={<WorkflowsListPage />} />
          <Route path="/design/:workflowId" element={<WorkflowStudioPage />} />
          <Route path="/run" element={<RunWorkflowPage />} />
          <Route path="/runs" element={<RunsDashboardPage />} />
          <Route path="/runs/:id" element={<RunViewerPage />} />
          <Route path="/runs/:id/artifacts" element={<RunArtifactsPage />} />
          <Route path="/runs/:id/insights" element={<RunInsightsPage />} />
          <Route path="/mission-control/:id" element={<RunInsightsPage />} />
          <Route path="/play/new" element={<RunPlayerEntry />} />
          <Route path="/play/:runId" element={<RunPlayerPage />} />
          <Route path="/runtime" element={<InboxPage />} />
          <Route path="/runtime/history" element={<HistoryPage />} />
          <Route path="/runtime/work/:kind/:id" element={<WorkDetailPage />} />
          <Route path="/work-items" element={<WorkItemsPage />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/metadata" element={<MetadataRegistryPage />} />
          <Route path="/node-types" element={<CustomNodeTypesPage />} />
          <Route path="/artifacts" element={<ArtifactDesignerPage />} />
          <Route path="/artifacts/:id" element={<ArtifactEditorPage />} />
          <Route path="/artifacts-explorer" element={<ArtifactsExplorerPage />} />
          <Route path="/curation" element={<CurationPage />} />
          <Route path="/team-variables" element={<TeamVariablesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyWorkflowsRoute() {
  return <LegacyWorkgraphRouter initialEntry="/templates" />;
}

export function LegacyWorkflowDesignRoute({ workflowId }: { workflowId: string }) {
  return <LegacyWorkgraphRouter initialEntry={`/design/${workflowId}`} />;
}

export function LegacyRunsDashboardRoute() {
  return <LegacyWorkgraphRouter initialEntry="/runs" />;
}

export function LegacyRunWorkflowRoute() {
  return <LegacyWorkgraphRouter initialEntry="/run" />;
}

export function LegacyHistoryRoute() {
  return <LegacyWorkgraphRouter initialEntry="/runtime/history" />;
}

export function LegacyWorkItemsRoute() {
  return <LegacyWorkgraphRouter initialEntry="/work-items" />;
}

export function LegacyConnectorsRoute() {
  return <LegacyWorkgraphRouter initialEntry="/connectors" />;
}

export function LegacyMetadataRoute() {
  return <LegacyWorkgraphRouter initialEntry="/metadata" />;
}

export function LegacyArtifactDesignerRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/artifacts"]}>
        <Routes>
          <Route path="/artifacts" element={<ArtifactDesignerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyArtifactEditorRoute({ artifactId }: { artifactId: string }) {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/artifacts/${artifactId}`]}>
        <Routes>
          <Route path="/artifacts/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyArtifactsExplorerRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/artifacts-explorer"]}>
        <Routes>
          <Route path="/artifacts-explorer" element={<ArtifactsExplorerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyNodeTypesRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/node-types"]}>
        <Routes>
          <Route path="/node-types" element={<CustomNodeTypesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyPlannerRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/planner"]}>
        <Routes>
          <Route path="/planner" element={<PlannerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyInboxRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/runtime"]}>
        <Routes>
          <Route path="/runtime" element={<InboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyWorkDetailRoute({ kind, id, query = "" }: { kind: string; id: string; query?: string }) {
  const queryClient = useMemo(createQueryClient, []);
  const suffix = query ? `?${query.replace(/^\?/, "")}` : "";
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/runtime/work/${kind}/${id}${suffix}`]}>
        <Routes>
          <Route path="/runtime/work/:kind/:id" element={<WorkDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyCurationRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/curation"]}>
        <Routes>
          <Route path="/curation" element={<CurationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function LegacyTeamVariablesRoute() {
  const queryClient = useMemo(createQueryClient, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/team-variables"]}>
        <Routes>
          <Route path="/team-variables" element={<TeamVariablesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
