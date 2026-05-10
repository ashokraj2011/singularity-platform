import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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
import { RuntimeShell } from './features/runtime/RuntimeShell'
import { InboxPage } from './features/runtime/InboxPage'
import { WorkDetailPage } from './features/runtime/WorkDetailPage'
import { HistoryPage } from './features/runtime/HistoryPage'
import { RunViewerPage } from './features/runtime/RunViewerPage'
import { RunsDashboardPage } from './features/runtime/RunsDashboardPage'
import { RunPlayerPage, RunPlayerEntry } from './features/runtime/RunPlayerPage'
import { RunWorkflowPage } from './features/runtime/RunWorkflowPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAuthStore(s => s.token)
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"          element={<LoginPage />} />
        <Route path="/context-picker" element={<RequireAuth><ContextPickerPage /></RequireAuth>} />

        {/* End-user runtime — minimal shell, no studio chrome */}
        <Route
          path="/runtime"
          element={
            <RequireAuth>
              <RuntimeShell />
            </RequireAuth>
          }
        >
          <Route index                 element={<InboxPage />} />
          <Route path="history"        element={<HistoryPage />} />
          <Route path="work/:kind/:id" element={<WorkDetailPage />} />
        </Route>

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
          <Route path="run"                element={<RunWorkflowPage />} />
          <Route path="workflows"          element={<WorkflowsListPage />} />
          <Route path="node-types"         element={<CustomNodeTypesPage />} />
          <Route path="design/:workflowId"   element={<WorkflowStudioPage />} />
          <Route path="workflow/:instanceId" element={<WorkflowStudioPage />} />
          <Route path="runs"                 element={<RunsDashboardPage />} />
          <Route path="runs/:id"             element={<RunViewerPage />} />
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
    </BrowserRouter>
  )
}
