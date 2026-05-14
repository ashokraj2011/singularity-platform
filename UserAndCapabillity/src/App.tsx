import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from '@/components/RequireAuth'
import { AppLayout } from '@/components/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { UsersListPage } from '@/pages/users/UsersListPage'
import { UserDetailPage } from '@/pages/users/UserDetailPage'
import { BusinessUnitsPage } from '@/pages/business-units/BusinessUnitsPage'
import { TeamsListPage } from '@/pages/teams/TeamsListPage'
import { TeamDetailPage } from '@/pages/teams/TeamDetailPage'
import { CapabilitiesListPage } from '@/pages/capabilities/CapabilitiesListPage'
import { CapabilityDetailPage } from '@/pages/capabilities/CapabilityDetailPage'
import { CapabilityGraphPage } from '@/pages/capability-graph/CapabilityGraphPage'
import { RolesListPage } from '@/pages/roles/RolesListPage'
import { RoleDetailPage } from '@/pages/roles/RoleDetailPage'
import { PermissionsPage } from '@/pages/permissions/PermissionsPage'
import { SharingGrantsPage } from '@/pages/sharing-grants/SharingGrantsPage'
import { AuthzCheckPage } from '@/pages/authz/AuthzCheckPage'
import { AuditEventsPage } from '@/pages/audit/AuditEventsPage'
import { EventHorizonChat } from '@/components/EventHorizonChat'

export default function App() {
  return (
    <BrowserRouter>
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
