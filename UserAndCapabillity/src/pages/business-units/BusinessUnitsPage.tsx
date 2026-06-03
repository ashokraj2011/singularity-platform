import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Building2, ChevronRight, Pencil } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { TagsInput } from '@/components/TagsInput'
import { MetadataEditor } from '@/components/MetadataEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBusinessUnits, useCreateBusinessUnit, useUpdateBusinessUnit } from '@/hooks/useBusinessUnits'
import type { BusinessUnit } from '@/types'

const schema = z.object({
  bu_key: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, hyphens only'),
  name: z.string().min(1),
  description: z.string().optional(),
  parent_bu_id: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

function BuNode({ bu, allBus, depth = 0, onEdit }: { bu: BusinessUnit; allBus: BusinessUnit[]; depth?: number; onEdit: (bu: BusinessUnit) => void }) {
  const [expanded, setExpanded] = useState(true)
  const children = allBus.filter(b => b.parent_bu_id === bu.id)

  return (
    <div>
      <div
        className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
        style={{ paddingLeft: `${12 + depth * 20}px` }}
        onClick={() => setExpanded(e => !e)}
      >
        {children.length > 0 ? (
          <ChevronRight className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        ) : (
          <span className="w-3.5" />
        )}
        <Building2 className="w-4 h-4 text-gray-400 shrink-0" />
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-medium text-gray-900">{bu.name}</span>
          <span className="font-mono text-xs text-gray-400">{bu.bu_key}</span>
          {(bu.tags ?? []).map(t => (
            <span key={t} className="text-xs bg-[#e6f4ed] text-[#00843D] px-1.5 py-0.5 rounded-full">{t}</span>
          ))}
        </div>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 transition-opacity"
          title="Edit business unit"
          onClick={e => { e.stopPropagation(); onEdit(bu) }}
        >
          <Pencil className="w-3.5 h-3.5 text-gray-500" />
        </button>
      </div>
      {expanded && children.map(child => (
        <BuNode key={child.id} bu={child} allBus={allBus} depth={depth + 1} onEdit={onEdit} />
      ))}
    </div>
  )
}

export function BusinessUnitsPage() {
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const { data, isLoading } = useBusinessUnits({ size: 200 })
  const createBU = useCreateBusinessUnit()
  const updateBU = useUpdateBusinessUnit()

  // Inline edit: name, description, parent (reparent = "add child" from the
  // other direction). Parent options exclude self + descendants to avoid an
  // obvious cycle; the server guards deeper cycles.
  const [editBu, setEditBu] = useState<BusinessUnit | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editParent, setEditParent] = useState<string>('')  // '' = no parent
  function openEdit(bu: BusinessUnit) {
    setEditBu(bu)
    setEditName(bu.name)
    setEditDesc(bu.description ?? '')
    setEditParent(bu.parent_bu_id ?? '')
  }
  function descendantIds(rootId: string, all: BusinessUnit[]): Set<string> {
    const out = new Set<string>()
    const stack = [rootId]
    while (stack.length) {
      const cur = stack.pop()!
      for (const b of all) {
        if (b.parent_bu_id === cur && !out.has(b.id)) { out.add(b.id); stack.push(b.id) }
      }
    }
    return out
  }
  const editParentOptions = (() => {
    if (!editBu) return []
    const blocked = descendantIds(editBu.id, data?.items ?? [])
    return (data?.items ?? []).filter(b => b.id !== editBu.id && !blocked.has(b.id))
  })()
  async function submitEdit() {
    if (!editBu) return
    const body: { name?: string; description?: string | null; parent_bu_id?: string | null } = {}
    if (editName.trim() && editName.trim() !== editBu.name) body.name = editName.trim()
    if ((editDesc || '') !== (editBu.description ?? '')) body.description = editDesc || null
    const nextParent = editParent || null
    if (nextParent !== (editBu.parent_bu_id ?? null)) body.parent_bu_id = nextParent
    if (Object.keys(body).length === 0) { setEditBu(null); return }
    await updateBU.mutateAsync({ id: editBu.id, body })
    setEditBu(null)
  }

  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  function handleClose() {
    reset()
    setTags([])
    setMetadata({})
    setOpen(false)
  }

  async function onSubmit(values: FormValues) {
    await createBU.mutateAsync({ ...values, tags, metadata })
    handleClose()
  }

  const roots = data?.items.filter(bu => !bu.parent_bu_id) ?? []

  return (
    <div className="p-8">
      <PageHeader
        title="Business Units"
        subtitle="Organizational hierarchy"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New Business Unit
          </Button>
        }
      />

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        {isLoading ? (
          <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
        ) : !data?.items.length ? (
          <EmptyState icon={Building2} title="No business units" description="Create your first business unit." />
        ) : (
          roots.map(bu => (
            <BuNode key={bu.id} bu={bu} allBus={data.items} onEdit={openEdit} />
          ))
        )}
      </div>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Business Unit</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Key *</Label>
              <Input placeholder="enterprise-technology" {...register('bu_key')} />
              {errors.bu_key && <p className="text-xs text-red-600">{errors.bu_key.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="Enterprise Technology" {...register('name')} />
              {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional description" {...register('description')} />
            </div>
            <div className="space-y-1.5">
              <Label>Parent Business Unit</Label>
              <Select onValueChange={(v: unknown) => setValue('parent_bu_id', String(v))}>
                <SelectTrigger><SelectValue placeholder="None (root)" /></SelectTrigger>
                <SelectContent>
                  {data?.items.map(bu => (
                    <SelectItem key={bu.id} value={bu.id}>{bu.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <TagsInput value={tags} onChange={setTags} placeholder="Add tag, press Enter…" />
            </div>
            <div className="space-y-1.5">
              <Label>Metadata</Label>
              <MetadataEditor value={metadata} onChange={setMetadata} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={handleClose}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#00843D] hover:bg-[#006830]">
                {isSubmitting ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editBu} onOpenChange={o => { if (!o) setEditBu(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Edit Business Unit</DialogTitle></DialogHeader>
          {editBu && (
            <div className="space-y-4 mt-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Input value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Optional description" />
              </div>
              <div className="space-y-1.5">
                <Label>Parent Business Unit</Label>
                <Select value={editParent || 'none'} onValueChange={v => setEditParent(v && v !== 'none' ? v : '')}>
                  <SelectTrigger><SelectValue placeholder="None (root)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (root)</SelectItem>
                    {editParentOptions.map(b => (
                      <SelectItem key={b.id} value={b.id}>{b.name} · {b.bu_key}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-400">Re-parenting under another BU is how you nest it as a child. Self and descendants are hidden to prevent cycles.</p>
              </div>
              {updateBU.isError && (
                <p className="text-xs text-red-600">
                  {(updateBU.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Update failed.'}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setEditBu(null)}>Cancel</Button>
                <Button onClick={submitEdit} disabled={updateBU.isPending} className="bg-[#00843D] hover:bg-[#006830]">
                  {updateBU.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
