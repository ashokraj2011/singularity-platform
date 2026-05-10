import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Building2, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { TagsInput } from '@/components/TagsInput'
import { MetadataEditor } from '@/components/MetadataEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBusinessUnits, useCreateBusinessUnit } from '@/hooks/useBusinessUnits'
import type { BusinessUnit } from '@/types'

const schema = z.object({
  bu_key: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, hyphens only'),
  name: z.string().min(1),
  description: z.string().optional(),
  parent_bu_id: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

function BuNode({ bu, allBus, depth = 0 }: { bu: BusinessUnit; allBus: BusinessUnit[]; depth?: number }) {
  const [expanded, setExpanded] = useState(true)
  const children = allBus.filter(b => b.parent_bu_id === bu.id)

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
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
      </div>
      {expanded && children.map(child => (
        <BuNode key={child.id} bu={child} allBus={allBus} depth={depth + 1} />
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
            <BuNode key={bu.id} bu={bu} allBus={data.items} />
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
    </div>
  )
}
