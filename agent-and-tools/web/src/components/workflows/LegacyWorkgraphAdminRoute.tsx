"use client";

import { Suspense, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { WorkItemsPage } from "workgraph-web/features/runtime/WorkItemsPage";
import { WorkDetailPage } from "workgraph-web/features/runtime/WorkDetailPage";
import { MetadataRegistryPage } from "workgraph-web/features/metadata/MetadataRegistryPage";
import { PlannerPage } from "workgraph-web/features/planner/PlannerPage";
import { CustomNodeTypesPage } from "workgraph-web/features/workflow/CustomNodeTypesPage";
import { WorkflowStudioPage } from "workgraph-web/features/workflow/WorkflowStudioPage";
import { WorkflowsListPage } from "workgraph-web/features/workflow/WorkflowsListPage";
import { WorkgraphSurfaceBoundary } from "@/components/workflows/WorkgraphSurfaceBoundary";

// These workgraph-web feature pages now route natively on Next (next/navigation),
// so the old MemoryRouter/Routes embedding is gone. Each Next route under
// /app/{workflows,runs,work-items,audit,identity} renders the matching page
// directly; route params (workflowId, kind/id, …) are read by the page via Next's
// useParams, and search params via Next's useSearchParams. All these wrappers do
// now is provide the react-query client the pages share.

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

function WgProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useMemo(createQueryClient, []);
  // Suspense boundary so the embedded workgraph-web pages can call
  // next/navigation useSearchParams() without breaking `next build` static
  // prerender (covers every Legacy*Route, which all render through WgProvider).
  return (
    <QueryClientProvider client={queryClient}>
      <WorkgraphSurfaceBoundary surfaceLabel="Workgraph surface">
        <Suspense fallback={<div style={{ padding: 24, color: "var(--color-outline)" }}>Loading…</div>}>
          {children}
        </Suspense>
      </WorkgraphSurfaceBoundary>
    </QueryClientProvider>
  );
}

export function LegacyWorkflowsRoute() {
  return <WgProvider><WorkflowsListPage /></WgProvider>;
}

// workflowId is now read from the Next route segment (/workflows/design/[workflowId])
// by WorkflowStudioPage itself; the prop is kept for the caller's signature.
export function LegacyWorkflowDesignRoute(_props: { workflowId: string }) {
  return <WgProvider><WorkflowStudioPage /></WgProvider>;
}

export function LegacyRunsDashboardRoute() {
  return <WgProvider><RunsDashboardPage /></WgProvider>;
}

export function LegacyRunWorkflowRoute() {
  return <WgProvider><RunWorkflowPage /></WgProvider>;
}

export function LegacyHistoryRoute() {
  return <WgProvider><HistoryPage /></WgProvider>;
}

export function LegacyWorkItemsRoute() {
  return <WgProvider><WorkItemsPage /></WgProvider>;
}

export function LegacyConnectorsRoute() {
  return <WgProvider><ConnectorsPage /></WgProvider>;
}

export function LegacyMetadataRoute() {
  return <WgProvider><MetadataRegistryPage /></WgProvider>;
}

export function LegacyArtifactDesignerRoute() {
  return <WgProvider><ArtifactDesignerPage /></WgProvider>;
}

// id is read from the Next route segment (/workflows/artifacts/[id]) by the page.
export function LegacyArtifactEditorRoute(_props: { artifactId: string }) {
  return <WgProvider><ArtifactEditorPage /></WgProvider>;
}

export function LegacyArtifactsExplorerRoute() {
  return <WgProvider><ArtifactsExplorerPage /></WgProvider>;
}

export function LegacyNodeTypesRoute() {
  return <WgProvider><CustomNodeTypesPage /></WgProvider>;
}

export function LegacyPlannerRoute() {
  return <WgProvider><PlannerPage /></WgProvider>;
}

export function LegacyInboxRoute() {
  return <WgProvider><InboxPage /></WgProvider>;
}

// kind/id are read from the Next route segment (/workflows/work/[kind]/[id]) and the
// query from Next's useSearchParams by WorkDetailPage itself.
export function LegacyWorkDetailRoute(_props: { kind: string; id: string; query?: string }) {
  return <WgProvider><WorkDetailPage /></WgProvider>;
}

export function LegacyCurationRoute() {
  return <WgProvider><CurationPage /></WgProvider>;
}

export function LegacyTeamVariablesRoute() {
  return <WgProvider><TeamVariablesPage /></WgProvider>;
}
