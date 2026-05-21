import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ShieldPlus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { StatusBadge } from '@/components/StatusBadge'
import { useUser, useUserRoles, useAssignUserRole, useRemoveUserRole, useUserTeams } from '@/hooks/useUsers'
import { useRoles } from '@/hooks/useRoles'
import { userStatusColor, formatDateTime } from '@/lib/format'

export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()

  const { data: user, isLoading } = useUser(userId!)
  const { data: userRoles, isLoading: rolesLoading } = useUserRoles(userId!)
  const { data: allRoles } = useRoles({ size: 500 })
  const { data: userTeams, isLoading: teamsLoading } = useUserTeams(userId!)

  const assignRole = useAssignUserRole(userId!)
  const removeRole = useRemoveUserRole(userId!)

  const [assignOpen, setAssignOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedRoleKey, setSelectedRoleKey] = useState('')
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading…</div>
  if (!user) return <div className="p-8 text-sm text-gray-500">User not found.</div>

  const assignedRoleKeys = new Set((userRoles ?? []).map(r => r.role_key))

  const filteredRoles = (allRoles?.items ?? []).filter(r =>
    !assignedRoleKeys.has(r.role_key) &&
    (r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.role_key.toLowerCase().includes(search.toLowerCase()))
  )

  async function handleAssignRole() {
    if (!selectedRoleKey) return
    await assignRole.mutateAsync(selectedRoleKey)
    setSelectedRoleKey('')
    setSearch('')
    setAssignOpen(false)
  }

  return (
    <div className="p-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-gray-500" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>

      <div className="flex items-start gap-4 mb-6">
        <div className="w-12 h-12 rounded-full bg-[#00843D] flex items-center justify-center text-white font-semibold text-lg">
          {(user.display_name ?? user.email)[0].toUpperCase()}
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{user.display_name ?? user.email}</h1>
          {user.display_name && <p className="text-sm text-gray-500">{user.email}</p>}
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge label={user.status} className={userStatusColor(user.status)} />
            {user.is_super_admin && (
              <StatusBadge label="Super Admin" className="bg-[#e6f4ed] text-[#00843D]" />
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="info">
        <TabsList>
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
        </TabsList>

        {/* ── Info tab ── */}
        <TabsContent value="info" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            {[
              ['User ID', user.id],
              ['Auth Provider', user.auth_provider ?? '—'],
              ['External Subject', user.external_subject ?? '—'],
              ['Local Account', user.is_local_account ? 'Yes' : 'No'],
              ['Created', formatDateTime(user.created_at)],
              ['Updated', formatDateTime(user.updated_at)],
            ].map(([label, value]) => (
              <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 mb-1">{label}</p>
                <p className="text-sm font-medium text-gray-900 break-all">{value}</p>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── Roles tab ── */}
        <TabsContent value="roles" className="mt-4">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-gray-500">{userRoles?.length ?? 0} roles assigned</p>
            <Button size="sm" onClick={() => setAssignOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
              <ShieldPlus className="w-3.5 h-3.5 mr-1.5" /> Assign Role
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {rolesLoading ? (
              <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
            ) : !userRoles?.length ? (
              <p className="text-sm text-gray-400 text-center py-8">No roles assigned</p>
            ) : userRoles.map(role => (
              <div key={role.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{role.name}</p>
                  <p className="font-mono text-xs text-gray-400">{role.role_key}</p>
                </div>
                <div className="flex items-center gap-2">
                  {role.system_role && (
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">System</span>
                  )}
                  {!role.system_role && (
                    <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(role.role_key)}>
                      <Trash2 className="w-3.5 h-3.5 text-gray-400" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── Teams tab ── */}
        <TabsContent value="teams" className="mt-4">
          <div className="mb-3">
            <p className="text-sm text-gray-500">{userTeams?.length ?? 0} teams · manage membership from each team's page</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {teamsLoading ? (
              <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
            ) : !userTeams?.length ? (
              <p className="text-sm text-gray-400 text-center py-8">Not a member of any team</p>
            ) : userTeams.map(team => (
              <button
                key={team.id}
                type="button"
                onClick={() => navigate(`/teams/${team.id}`)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{team.name}</p>
                  <p className="font-mono text-xs text-gray-400">{team.team_key}</p>
                </div>
                <ArrowLeft className="w-3.5 h-3.5 text-gray-300 rotate-180" />
              </button>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Assign Role dialog ── */}
      <Dialog open={assignOpen} onOpenChange={open => { if (!open) { setSearch(''); setSelectedRoleKey('') } setAssignOpen(open) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign Role</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label>Search roles</Label>
              <Input placeholder="e.g. admin" value={search} onChange={e => { setSearch(e.target.value); setSelectedRoleKey('') }} />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-50">
              {filteredRoles.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-6">No available roles</p>
              ) : filteredRoles.map(r => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedRoleKey(r.role_key)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selectedRoleKey === r.role_key ? 'bg-[#e6f4ed]' : ''}`}
                >
                  <p className={`text-sm font-medium ${selectedRoleKey === r.role_key ? 'text-[#00843D]' : 'text-gray-900'}`}>{r.name}</p>
                  <p className="font-mono text-xs text-gray-400">{r.role_key}</p>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
              <Button
                onClick={handleAssignRole}
                disabled={!selectedRoleKey || assignRole.isPending}
                className="bg-[#00843D] hover:bg-[#006830]"
              >
                {assignRole.isPending ? 'Assigning…' : 'Assign'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Remove Role confirm ── */}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={o => { if (!o) setRemoveTarget(null) }}
        title="Remove role?"
        description="This will unassign the role from this user."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removeTarget) {
            await removeRole.mutateAsync(removeTarget)
            setRemoveTarget(null)
          }
        }}
        loading={removeRole.isPending}
      />
    </div>
  )
}
