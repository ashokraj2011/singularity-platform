import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Share2, CheckCircle, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useSharingGrants, useCreateSharingGrant, useApproveSharingGrant, useRevokeSharingGrant } from '@/hooks/useSharingGrants'
import { grantStatusColor, formatDate } from '@/lib/format'
import type { GrantType } from '@/types'

const PERMS_PLACEHOLDER = 'rule:view, rule:evaluate'

const schema = z.object({
  provider_capability_id: z.string().min(1),
  consumer_capability_id: z.string().min(1),
  grant_type: z.enum(['view', 'execute', 'integrate', 'administer_limited']),
  permissions_raw: z.string().min(1),
})
type FormValues = z.infer<typeof schema>

export function SharingGrantsPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const [open, setOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const { data, isLoading } = useSharingGrants({ status: statusFilter || undefined })
  const createGrant = useCreateSharingGrant()
  const approveGrant = useApproveSharingGrant()
  const revokeGrant = useRevokeSharingGrant()

  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { grant_type: 'execute' },
  })

  async function onSubmit(values: FormValues) {
    const allowed_permissions = values.permissions_raw.split(',').map(s => s.trim()).filter(Boolean)
    await createGrant.mutateAsync({
      provider_capability_id: values.provider_capability_id,
      consumer_capability_id: values.consumer_capability_id,
      grant_type: values.grant_type,
      allowed_permissions,
    })
    reset()
    setOpen(false)
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Sharing Grants"
        subtitle="Control capability sharing between applications"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New Grant
          </Button>
        }
      />

      <div className="flex gap-2 mb-4">
        {['', 'active', 'suspended', 'revoked'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${statusFilter === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : !data?.items.length ? (
          <EmptyState icon={Share2} title="No sharing grants" description="Create the first capability sharing grant." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Provider</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Consumer</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Type</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Created</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.items.map(g => (
                <tr key={g.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-800">{g.provider_capability_id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-800">{g.consumer_capability_id}</td>
                  <td className="px-4 py-3 text-gray-500">{g.grant_type}</td>
                  <td className="px-4 py-3">
                    <StatusBadge label={g.status} className={grantStatusColor(g.status)} />
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">{formatDate(g.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {g.status === 'active' && (
                        <Button variant="ghost" size="sm" onClick={() => approveGrant.mutate(g.id)} title="Approve">
                          <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                        </Button>
                      )}
                      {g.status !== 'revoked' && (
                        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(g.id)} title="Revoke">
                          <XCircle className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Sharing Grant</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Provider Capability ID *</Label>
              <Input placeholder="ccre-rule-engine" {...register('provider_capability_id')} />
              {errors.provider_capability_id && <p className="text-xs text-red-600">{errors.provider_capability_id.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Consumer Capability ID *</Label>
              <Input placeholder="personalization" {...register('consumer_capability_id')} />
              {errors.consumer_capability_id && <p className="text-xs text-red-600">{errors.consumer_capability_id.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Grant Type</Label>
              <Select defaultValue="execute" onValueChange={v => setValue('grant_type', v as GrantType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">View</SelectItem>
                  <SelectItem value="execute">Execute</SelectItem>
                  <SelectItem value="integrate">Integrate</SelectItem>
                  <SelectItem value="administer_limited">Administer (Limited)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Allowed Permissions (comma-separated) *</Label>
              <Input placeholder={PERMS_PLACEHOLDER} {...register('permissions_raw')} />
              {errors.permissions_raw && <p className="text-xs text-red-600">{errors.permissions_raw.message}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting} className="bg-[#00843D] hover:bg-[#006830]">
                {isSubmitting ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={o => { if (!o) setRevokeTarget(null) }}
        title="Revoke sharing grant?"
        description="This will permanently revoke the grant. Services relying on this grant will lose access."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revokeTarget) {
            await revokeGrant.mutateAsync(revokeTarget)
            setRevokeTarget(null)
          }
        }}
        loading={revokeGrant.isPending}
      />
    </div>
  )
}
