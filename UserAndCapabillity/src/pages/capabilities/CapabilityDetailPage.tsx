import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, GitBranch, ShieldCheck, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusBadge } from '@/components/StatusBadge'
import { useCapability, useCapabilityRelationships, useCapabilityMembers, useAddCapabilityRelationship, useAddCapabilityMember } from '@/hooks/useCapabilities'
import { capabilityTypeColor, capabilityTypeLabel, formatDate } from '@/lib/format'
import type { RelationshipType, InheritancePolicy } from '@/types'

const REL_TYPES: RelationshipType[] = ['contains','parent_child','uses','depends_on','shared_with','delivers_to','collects_from','governed_by']
const INH_POLICIES: InheritancePolicy[] = ['none','inherit_view','inherit_execute','inherit_admin','explicit_grant_only']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function CapabilityDetailPage() {
  const { capabilityId } = useParams<{ capabilityId: string }>()
  const navigate = useNavigate()
  const { data: cap, isLoading } = useCapability(capabilityId!)
  const { data: rels } = useCapabilityRelationships(capabilityId!)
  const { data: members } = useCapabilityMembers(capabilityId!)
  const addRel = useAddCapabilityRelationship(capabilityId!)
  const addMember = useAddCapabilityMember(capabilityId!)

  const [relOpen, setRelOpen] = useState(false)
  const [memberOpen, setMemberOpen] = useState(false)
  const [relTarget, setRelTarget] = useState('')
  const [relType, setRelType] = useState<RelationshipType>('uses')
  const [relPolicy, setRelPolicy] = useState<InheritancePolicy>('none')
  const [memberUserId, setMemberUserId] = useState('')
  const [memberRoleKey, setMemberRoleKey] = useState('')

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading…</div>
  if (!cap) return <div className="p-8 text-sm text-gray-500">Capability not found.</div>
  const agentToolsCapabilityHref = UUID_RE.test(cap.capability_id)
    ? `http://localhost:3000/capabilities/${cap.capability_id}`
    : 'http://localhost:3000/capabilities'

  async function handleAddRel() {
    if (!relTarget.trim()) return
    await addRel.mutateAsync({ target_capability_id: relTarget.trim(), relationship_type: relType, inheritance_policy: relPolicy })
    setRelTarget('')
    setRelOpen(false)
  }

  async function handleAddMember() {
    if (!memberUserId.trim() || !memberRoleKey.trim()) return
    await addMember.mutateAsync({ user_id: memberUserId.trim(), role_key: memberRoleKey.trim() })
    setMemberUserId('')
    setMemberRoleKey('')
    setMemberOpen(false)
  }

  return (
    <div className="p-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-gray-500" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>

      <div className="flex items-start gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900">{cap.name}</h1>
            <StatusBadge label={capabilityTypeLabel(cap.capability_type)} className={capabilityTypeColor(cap.capability_type)} />
          </div>
          <p className="font-mono text-sm text-gray-400 mt-0.5">{cap.capability_id}</p>
          {cap.description && <p className="text-sm text-gray-500 mt-1">{cap.description}</p>}
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-[#00843D] mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-gray-900">IAM reference only</p>
            <p className="text-sm text-gray-600 mt-0.5">
              Bootstrap, generated agents, repo/doc learning, and approval packets are owned by Agent Studio.
              Use IAM here for members, roles, relationships, sharing, and authorization checks.
            </p>
          </div>
        </div>
        <a href={agentToolsCapabilityHref} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm">
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open in Agent Studio
          </Button>
        </a>
      </div>

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="members">
            Members {members ? `(${members.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="relationships">
            Relationships {rels ? `(${rels.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            {[
              ['Capability ID', cap.capability_id],
              ['Status', cap.status],
              ['Visibility', cap.visibility],
              ['Owner BU', cap.owner_bu_id ?? '—'],
              ['Owner Team', cap.owner_team_id ?? '—'],
              ['Created', formatDate(cap.created_at)],
            ].map(([l, v]) => (
              <div key={l} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 mb-1">{l}</p>
                <p className="text-sm font-medium text-gray-900">{v}</p>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="members" className="mt-4">
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => setMemberOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
              <Users className="w-3.5 h-3.5 mr-1.5" /> Add Member
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {!members?.length ? (
              <p className="text-sm text-gray-400 text-center py-8">No members</p>
            ) : members.map(m => (
              <div key={m.id} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-900 font-mono">{m.user_id ?? m.team_id}</p>
                  <p className="text-xs text-gray-400">{m.user_id ? 'User' : 'Team'} · {m.role_id} · {m.status}</p>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="relationships" className="mt-4">
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => setRelOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
              <GitBranch className="w-3.5 h-3.5 mr-1.5" /> Add Relationship
            </Button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {!rels?.length ? (
              <p className="text-sm text-gray-400 text-center py-8">No relationships</p>
            ) : rels.map(r => (
              <div key={r.id} className="px-4 py-3 flex items-center gap-3">
                <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-700">{r.source_capability_id}</span>
                <span className="text-xs text-indigo-600 font-medium">{r.relationship_type}</span>
                <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-700">{r.target_capability_id}</span>
                <span className="text-xs text-gray-400 ml-auto">{r.inheritance_policy}</span>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Add Relationship Dialog */}
      <Dialog open={relOpen} onOpenChange={setRelOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Relationship</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Target Capability ID</Label>
              <Input placeholder="ccre-rule-engine" value={relTarget} onChange={e => setRelTarget(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Relationship Type</Label>
              <Select defaultValue="uses" onValueChange={v => setRelType(v as RelationshipType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REL_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Inheritance Policy</Label>
              <Select defaultValue="none" onValueChange={v => setRelPolicy(v as InheritancePolicy)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INH_POLICIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setRelOpen(false)}>Cancel</Button>
              <Button onClick={handleAddRel} disabled={addRel.isPending} className="bg-[#00843D] hover:bg-[#006830]">
                {addRel.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={memberOpen} onOpenChange={setMemberOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Capability Member</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>User ID</Label>
              <Input placeholder="UUID" value={memberUserId} onChange={e => setMemberUserId(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Role Key</Label>
              <Input placeholder="workflow_executor" value={memberRoleKey} onChange={e => setMemberRoleKey(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setMemberOpen(false)}>Cancel</Button>
              <Button onClick={handleAddMember} disabled={addMember.isPending} className="bg-[#00843D] hover:bg-[#006830]">
                {addMember.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
