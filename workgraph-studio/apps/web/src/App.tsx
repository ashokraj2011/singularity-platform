import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { useAuthStore } from './store/auth.store'
import { AppLayout } from './components/AppLayout'
import { LoginPage } from './features/identity/LoginPage'
import { ContextPickerPage } from './features/identity/ContextPickerPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { WorkflowStudioPage } from './features/workflow/WorkflowStudioPage'
import { WorkflowsListPage } from './features/workflow/WorkflowsListPage'
import { CustomNodeTypesPage } from './features/workflow/CustomNodeTypesPage'
import { AuditPage } from './features/audit/AuditPage'
import { ConnectorsPage } from './features/connectors/ConnectorsPage'
import { ArtifactDesignerPage } from './features/artifact/ArtifactDesignerPage'
import { ArtifactEditorPage } from './features/artifact/ArtifactEditorPage'
import { TeamVariablesPage } from './features/identity/TeamVariablesPage'
import { InboxPage } from './features/runtime/InboxPage'
import { WorkDetailPage } from './features/runtime/WorkDetailPage'
import { WorkItemsPage } from './features/runtime/WorkItemsPage'
import { HistoryPage } from './features/runtime/HistoryPage'
import { RunViewerPage } from './features/runtime/RunViewerPage'
import { RunInsightsPage } from './features/runtime/RunInsightsPage'
import { RunsDashboardPage } from './features/runtime/RunsDashboardPage'
import { RunPlayerPage, RunPlayerEntry } from './features/runtime/RunPlayerPage'
import { RunWorkflowPage } from './features/runtime/RunWorkflowPage'
import { EventHorizonChat } from './components/EventHorizonChat'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore(s => s.token)
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

// Legacy /workflow/:instanceId used to render the designer canvas in
// read-only mode for live runs — that conflated authoring with execution.
// All callers now route to /runs/:id directly; this preserves old links.
function NavigateLegacyWorkflowInstance() {
  const { instanceId } = useParams<{ instanceId: string }>()
  return <Navigate to={`/runs/${instanceId ?? ''}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"          element={<LoginPage />} />
        <Route path="/context-picker" element={<RequireAuth><ContextPickerPage /></RequireAuth>} />

        {/* Designer / admin shell */}
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"          element={<DashboardPage />} />
          <Route path="runtime"            element={<InboxPage />} />
          <Route path="work-items"         element={<WorkItemsPage />} />
          <Route path="runtime/history"    element={<HistoryPage />} />
          <Route path="runtime/work/:kind/:id" element={<WorkDetailPage />} />
          <Route path="run"                element={<RunWorkflowPage />} />
          <Route path="workflows"          element={<WorkflowsListPage />} />
          <Route path="node-types"         element={<CustomNodeTypesPage />} />
          <Route path="design/:workflowId"   element={<WorkflowStudioPage />} />
          {/* Retired — runtime view lives at /runs/:id (RunViewerPage). The
              designer canvas is no longer reused for live instances. */}
          <Route path="workflow/:instanceId" element={<NavigateLegacyWorkflowInstance />} />
          <Route path="runs"                 element={<RunsDashboardPage />} />
          <Route path="runs/:id"             element={<RunViewerPage />} />
          <Route path="runs/:id/insights"    element={<RunInsightsPage />} />
          <Route path="mission-control/:id"  element={<RunInsightsPage />} />
          <Route path="play/new"             element={<RunPlayerEntry />} />
          <Route path="play/:runId"          element={<RunPlayerPage />} />
          <Route path="connectors"         element={<ConnectorsPage />} />
          <Route path="audit"              element={<AuditPage />} />
          <Route path="artifacts"          element={<ArtifactDesignerPage />} />
          <Route path="artifacts/:id"      element={<ArtifactEditorPage />} />
          <Route path="team-variables"     element={<TeamVariablesPage />} />
          <Route path="global-variables"   element={<TeamVariablesPage />} />
          <Route path="*"                  element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
      <EventHorizonChat />
    </BrowserRouter>
  )
}
