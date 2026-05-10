import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRole, useAddRolePermission, useRemoveRolePermission } from '@/hooks/useRoles'
import { usePermissions } from '@/hooks/usePermissions'

export function RoleDetailPage() {
  const { roleKey } = useParams<{ roleKey: string }>()
  const navigate = useNavigate()
  const { data: role, isLoading } = useRole(roleKey!)
  const { data: allPerms } = usePermissions({ size: 500 })
  const addPerm = useAddRolePermission(roleKey!)
  const removePerm = useRemoveRolePermission(roleKey!)

  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading…</div>
  if (!role) return <div className="p-8 text-sm text-gray-500">Role not found.</div>

  const filtered = allPerms?.items.filter(p =>
    p.permission_key.includes(search.toLowerCase())
  ) ?? []

  async function handleAdd() {
    if (!selected) return
    await addPerm.mutateAsync({ permission_key: selected })
    setSelected('')
    setAddOpen(false)
  }

  return (
    <div className="p-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-gray-500" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>

      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">{role.name}</h1>
          {role.system_role && (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">System</span>
          )}
        </div>
        <p className="font-mono text-sm text-gray-400 mt-0.5">{role.role_key}</p>
        {role.description && <p className="text-sm text-gray-500 mt-1">{role.description}</p>}
      </div>

      <Tabs defaultValue="permissions">
        <TabsList>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="info">Info</TabsTrigger>
        </TabsList>

        <TabsContent value="permissions" className="mt-4">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-gray-500">Permissions assigned to this role</p>
            {!role.system_role && (
              <Button size="sm" onClick={() => setAddOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Permission
              </Button>
            )}
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
            {!allPerms?.items.length ? (
              <p className="text-sm text-gray-400 text-center py-8">No permissions assigned</p>
            ) : (
              allPerms.items.map(p => (
                <div key={p.id} className="px-4 py-2.5 flex items-center justify-between">
                  <span className="font-mono text-xs text-gray-700">{p.permission_key}</span>
                  {!role.system_role && (
                    <Button variant="ghost" size="sm" onClick={() => removePerm.mutate(p.permission_key)}>
                      <Trash2 className="w-3.5 h-3.5 text-gray-400" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="info" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            {[['Role Key', role.role_key], ['Scope', role.role_scope], ['System Role', role.system_role ? 'Yes' : 'No']].map(([l, v]) => (
              <div key={l} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-400 mb-1">{l}</p>
                <p className="text-sm font-medium text-gray-900">{String(v)}</p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Permission</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label>Search permissions</Label>
              <Input placeholder="workflow:create" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-50">
              {filtered.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(p.permission_key)}
                  className={`w-full text-left px-3 py-2 text-xs font-mono hover:bg-gray-50 transition-colors ${selected === p.permission_key ? 'bg-[#e6f4ed] text-[#00843D]' : 'text-gray-700'}`}
                >
                  {p.permission_key}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button onClick={handleAdd} disabled={!selected || addPerm.isPending} className="bg-[#00843D] hover:bg-[#006830]">
                {addPerm.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
