import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, ShieldCheck, Lock } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { TagsInput } from '@/components/TagsInput'
import { MetadataEditor } from '@/components/MetadataEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRoles, useCreateRole } from '@/hooks/useRoles'
import type { RoleScope } from '@/types'

const schema = z.object({
  role_key: z.string().min(1).regex(/^[a-z0-9_]+$/, 'Lowercase, numbers, underscores only'),
  name: z.string().min(1),
  description: z.string().optional(),
  role_scope: z.enum(['platform', 'capability']),
})
type FormValues = z.infer<typeof schema>

export function RolesListPage() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const { data, isLoading } = useRoles()
  const createRole = useCreateRole()

  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { role_scope: 'capability' },
  })

  function handleClose() {
    reset()
    setTags([])
    setMetadata({})
    setOpen(false)
  }

  async function onSubmit(values: FormValues) {
    await createRole.mutateAsync({ ...values, tags, metadata })
    handleClose()
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Roles"
        subtitle="Define named collections of permissions"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New Role
          </Button>
        }
      />

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : !data?.items.length ? (
        <EmptyState icon={ShieldCheck} title="No roles" description="Create the first role." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.items.map(role => (
            <div
              key={role.id}
              className="bg-white rounded-xl border border-gray-200 p-5 cursor-pointer hover:border-[#00843D]/40 hover:shadow-sm transition-all"
              onClick={() => navigate(`/roles/${role.role_key}`)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900">{role.name}</p>
                  <p className="font-mono text-xs text-gray-400 mt-0.5">{role.role_key}</p>
                </div>
                {role.system_role && <Lock className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
              </div>
              {role.description && (
                <p className="text-sm text-gray-500 mt-2 line-clamp-2">{role.description}</p>
              )}
              {(role.tags ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {role.tags.map(t => (
                    <span key={t} className="text-xs bg-[#e6f4ed] text-[#00843D] px-1.5 py-0.5 rounded-full">{t}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-gray-100">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${role.role_scope === 'platform' ? 'bg-indigo-100 text-indigo-700' : 'bg-sky-100 text-sky-700'}`}>
                  {role.role_scope}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Role</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Role Key *</Label>
              <Input placeholder="rule_executor" {...register('role_key')} />
              {errors.role_key && <p className="text-xs text-red-600">{errors.role_key.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="Rule Executor" {...register('name')} />
              {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional" {...register('description')} />
            </div>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select defaultValue="capability" onValueChange={v => setValue('role_scope', v as RoleScope)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="capability">Capability</SelectItem>
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
