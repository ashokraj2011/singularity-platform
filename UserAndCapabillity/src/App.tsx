import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from 'identity-web/components/RequireAuth'
import { AppLayout } from 'identity-web/components/AppLayout'
import { LoginPage } from 'identity-web/pages/LoginPage'
import { DashboardPage } from 'identity-web/pages/DashboardPage'
import { UsersListPage } from 'identity-web/pages/users/UsersListPage'
import { UserDetailPage } from 'identity-web/pages/users/UserDetailPage'
import { BusinessUnitsPage } from 'identity-web/pages/business-units/BusinessUnitsPage'
import { TeamsListPage } from 'identity-web/pages/teams/TeamsListPage'
import { TeamDetailPage } from 'identity-web/pages/teams/TeamDetailPage'
import { CapabilitiesListPage } from 'identity-web/pages/capabilities/CapabilitiesListPage'
import { CapabilityDetailPage } from 'identity-web/pages/capabilities/CapabilityDetailPage'
import { CapabilityGraphPage } from 'identity-web/pages/capability-graph/CapabilityGraphPage'
import { RolesListPage } from 'identity-web/pages/roles/RolesListPage'
import { RoleDetailPage } from 'identity-web/pages/roles/RoleDetailPage'
import { PermissionsPage } from 'identity-web/pages/permissions/PermissionsPage'
import { SharingGrantsPage } from 'identity-web/pages/sharing-grants/SharingGrantsPage'
import { AuthzCheckPage } from 'identity-web/pages/authz/AuthzCheckPage'
import { AuditEventsPage } from 'identity-web/pages/audit/AuditEventsPage'
import { EventHorizonChat } from 'identity-web/components/EventHorizonChat'
import { IDENTITY_BASE } from 'identity-web/vite-env-compat'

// M100 P1 — router basename matches the edge-gateway prefix ('/iam'); '/' standalone.
const ROUTER_BASENAME = IDENTITY_BASE.replace(/\/$/, '') || '/'

export default function App() {
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="users" element={<UsersListPage />} />
          <Route path="users/:userId" element={<UserDetailPage />} />
          <Route path="business-units" element={<BusinessUnitsPage />} />
          <Route path="teams" element={<TeamsListPage />} />
          <Route path="teams/:teamId" element={<TeamDetailPage />} />
          <Route path="capabilities" element={<CapabilitiesListPage />} />
          <Route path="capabilities/:capabilityId" element={<CapabilityDetailPage />} />
          <Route path="capability-graph" element={<CapabilityGraphPage />} />
          <Route path="roles" element={<RolesListPage />} />
          <Route path="roles/:roleKey" element={<RoleDetailPage />} />
          <Route path="permissions" element={<PermissionsPage />} />
          <Route path="sharing-grants" element={<SharingGrantsPage />} />
          <Route path="authz-check" element={<AuthzCheckPage />} />
          <Route path="audit" element={<AuditEventsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
      <EventHorizonChat />
    </BrowserRouter>
  )
}
