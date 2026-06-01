import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, UserPlus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useTeam, useTeams, useTeamMembers, useTeamChildren, useAddTeamMember, useRemoveTeamMember, useUpdateTeam, useAddChildTeam } from '@/hooks/useTeams'
import { formatDate } from '@/lib/format'

export function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>()
  const navigate = useNavigate()
  const { data: team, isLoading } = useTeam(teamId!)
  const { data: members } = useTeamMembers(teamId!)
  const { data: allTeams } = useTeams({ size: 200 })
  const { data: children } = useTeamChildren(teamId!)
  const addMember = useAddTeamMember(teamId!)
  const removeMember = useRemoveTeamMember(teamId!)
  const updateTeam = useUpdateTeam(teamId!)
  const addChild = useAddChildTeam(teamId!)

  const [addOpen, setAddOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [childPick, setChildPick] = useState('')

  // Teams selectable as PARENT: everything except this team and its own
  // children (prevents the obvious 1-level cycle in the UI; the server guards
  // deeper cycles).
  const childIds = new Set((children ?? []).map(c => c.id))
  const parentOptions = (allTeams?.items ?? []).filter(t => t.id !== teamId && !childIds.has(t.id))
  // Teams selectable as a NEW CHILD: not this team, not already a child, and
  // not already parented elsewhere-as-this-team's-parent.
  const childOptions = (allTeams?.items ?? []).filter(
    t => t.id !== teamId && !childIds.has(t.id) && t.id !== team?.parent_team_id,
  )

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading…</div>
  if (!team) return <div className="p-8 text-sm text-gray-500">Team not found.</div>

  async function handleAddMember() {
    if (!userId.trim()) return
    await addMember.mutateAsync({ user_id: userId.trim() })
    setUserId('')
    setAddOpen(false)
  }

  return (
    <div className="p-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-gray-500" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">{team.name}</h1>
        <p className="font-mono text-sm text-gray-400 mt-0.5">{team.team_key}</p>
        {team.description && <p className="text-sm text-gray-500 mt-1">{team.description}</p>}
      </div>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="hierarchy">Hierarchy</TabsTrigger>
          <TabsTrigger value="info">Info</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="mt-4">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-gray-500">{members?.length ?? 0} members</p>
            <Button size="sm" onClick={() => setAddOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
              <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Add Member
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {!members?.length ? (
              <p className="text-sm text-gray-400 text-center py-8">No members yet</p>
            ) : members.map(m => (
              <div key={m.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 font-mono">{m.user_id}</p>
                  <p className="text-xs text-gray-400">{m.membership_type} · {formatDate(m.created_at)}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(m.user_id)}>
                  <Trash2 className="w-3.5 h-3.5 text-gray-400" />
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="hierarchy" className="mt-4 space-y-6">
          {/* Parent team */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-medium text-gray-900 mb-1">Parent team</p>
            <p className="text-xs text-gray-400 mb-3">Choose this team’s parent, or “No parent” to make it a top-level team.</p>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 h-9 rounded-md border border-gray-200 px-2 text-sm"
                value={team.parent_team_id ?? ''}
                disabled={updateTeam.isPending}
                onChange={e => updateTeam.mutate({ parent_team_id: e.target.value ? e.target.value : null })}
              >
                <option value="">No parent (top-level)</option>
                {parentOptions.map(t => (
                  <option key={t.id} value={t.id}>{t.name} · {t.team_key}</option>
                ))}
              </select>
              {updateTeam.isPending && <span className="text-xs text-gray-400">Saving…</span>}
            </div>
            {updateTeam.isError && (
              <p className="text-xs text-red-500 mt-2">
                {(updateTeam.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Update failed.'}
              </p>
            )}
          </div>

          {/* Child teams */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-medium text-gray-900 mb-1">Child teams</p>
            <p className="text-xs text-gray-400 mb-3">Teams whose parent is this team.</p>
            <div className="flex items-center gap-2 mb-3">
              <select
                className="flex-1 h-9 rounded-md border border-gray-200 px-2 text-sm"
                value={childPick}
                onChange={e => setChildPick(e.target.value)}
              >
                <option value="">Select a team to add as child…</option>
                {childOptions.map(t => (
                  <option key={t.id} value={t.id}>{t.name} · {t.team_key}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!childPick || addChild.isPending}
                className="bg-[#00843D] hover:bg-[#006830]"
                onClick={async () => { await addChild.mutateAsync(childPick); setChildPick('') }}
              >
                {addChild.isPending ? 'Adding…' : 'Add child'}
              </Button>
            </div>
            {addChild.isError && (
              <p className="text-xs text-red-500 mb-2">
                {(addChild.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Add child failed.'}
              </p>
            )}
            <div className="divide-y divide-gray-50">
              {!children?.length ? (
                <p className="text-sm text-gray-400 text-center py-6">No child teams</p>
              ) : children.map(c => (
                <button
                  key={c.id}
                  className="w-full flex items-center justify-between px-1 py-2 text-left hover:bg-gray-50 rounded"
                  onClick={() => navigate(`/teams/${c.id}`)}
                >
                  <span className="text-sm font-medium text-gray-900">{c.name}</span>
                  <span className="font-mono text-xs text-gray-400">{c.team_key}</span>
                </button>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="info" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            {[['Team ID', team.id], ['BU ID', team.bu_id ?? '—'], ['Created', formatDate(team.created_at)]].map(([l, v]) => (
              <div key={l} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 mb-1">{l}</p>
                <p className="text-sm font-medium text-gray-900 break-all">{v}</p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Team Member</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>User ID</Label>
              <Input placeholder="UUID" value={userId} onChange={e => setUserId(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button onClick={handleAddMember} disabled={addMember.isPending} className="bg-[#00843D] hover:bg-[#006830]">
                {addMember.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={o => { if (!o) setRemoveTarget(null) }}
        title="Remove member?"
        description="This will remove the user from the team."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removeTarget) {
            await removeMember.mutateAsync(removeTarget)
            setRemoveTarget(null)
          }
        }}
        loading={removeMember.isPending}
      />
    </div>
  )
}
