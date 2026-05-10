import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Layers } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { TagsInput } from '@/components/TagsInput'
import { MetadataEditor } from '@/components/MetadataEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCapabilities, useCreateCapability } from '@/hooks/useCapabilities'
import { capabilityTypeColor, capabilityTypeLabel, formatDate } from '@/lib/format'
import type { CapabilityType, CapabilityVisibility } from '@/types'

const TYPES: CapabilityType[] = [
  'business_capability', 'application_capability', 'shared_capability',
  'delivery_capability', 'collection_capability', 'platform_capability', 'technical_capability',
]

const schema = z.object({
  capability_id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Lowercase, numbers, hyphens only'),
  name: z.string().min(1),
  description: z.string().optional(),
  capability_type: z.enum(['business_capability', 'application_capability', 'shared_capability',
    'delivery_capability', 'collection_capability', 'platform_capability', 'technical_capability']),
  visibility: z.enum(['private', 'shared', 'platform']).optional(),
})
type FormValues = z.infer<typeof schema>

export function CapabilitiesListPage() {
  const navigate = useNavigate()
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const { data, isLoading } = useCapabilities({ capability_type: typeFilter || undefined })
  const createCap = useCreateCapability()

  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { capability_type: 'business_capability', visibility: 'private' },
  })

  function handleClose() {
    reset()
    setTags([])
    setMetadata({})
    setOpen(false)
  }

  async function onSubmit(values: FormValues) {
    await createCap.mutateAsync({ ...values, tags, metadata })
    handleClose()
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Capabilities"
        subtitle="Manage application and product boundaries"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New Capability
          </Button>
        }
      />

      {/* Type filter pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => setTypeFilter('')}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${!typeFilter ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          All
        </button>
        {TYPES.map(t => (
          <button
            key={t}
            onClick={() => setTypeFilter(t === typeFilter ? '' : t)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${typeFilter === t ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {capabilityTypeLabel(t)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : !data?.items.length ? (
          <EmptyState icon={Layers} title="No capabilities" description="Create the first capability." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Capability</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Type</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Visibility</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Tags</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.items.map(cap => (
                <tr
                  key={cap.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/capabilities/${cap.capability_id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{cap.name}</div>
                    <div className="font-mono text-xs text-gray-400">{cap.capability_id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge label={capabilityTypeLabel(cap.capability_type)} className={capabilityTypeColor(cap.capability_type)} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{cap.visibility}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(cap.tags ?? []).map(t => (
                        <span key={t} className="text-xs bg-[#e6f4ed] text-[#00843D] px-1.5 py-0.5 rounded-full">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      label={cap.status}
                      className={cap.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}
                    />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(cap.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Capability</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Capability ID *</Label>
              <Input placeholder="personalization" {...register('capability_id')} />
              {errors.capability_id && <p className="text-xs text-red-600">{errors.capability_id.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="Personalization" {...register('name')} />
              {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional" {...register('description')} />
            </div>
            <div className="space-y-1.5">
              <Label>Type *</Label>
              <Select defaultValue="business_capability" onValueChange={v => setValue('capability_type', v as CapabilityType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map(t => <SelectItem key={t} value={t}>{capabilityTypeLabel(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Visibility</Label>
              <Select defaultValue="private" onValueChange={v => setValue('visibility', v as CapabilityVisibility)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="shared">Shared</SelectItem>
                  <SelectItem value="platform">Platform</SelectItem>
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
