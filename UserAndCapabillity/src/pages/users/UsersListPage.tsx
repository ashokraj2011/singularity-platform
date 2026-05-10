import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Search, Users } from 'lucide-react'
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
import { useUsers, useCreateUser } from '@/hooks/useUsers'
import { userStatusColor, formatDate } from '@/lib/format'
import type { AuthProvider } from '@/types'

const schema = z.object({
  email: z.string().email(),
  display_name: z.string().optional(),
  auth_provider: z.enum(['github', 'pingfederate', 'oidc', 'local']).optional(),
  external_subject: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

export function UsersListPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const { data, isLoading } = useUsers({ search: search || undefined })
  const createUser = useCreateUser()

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
    await createUser.mutateAsync({ ...values, tags, metadata })
    handleClose()
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Users"
        subtitle="Manage user identities"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New User
          </Button>
        }
      />

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          className="pl-9"
          placeholder="Search users…"
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : !data?.items.length ? (
          <EmptyState icon={Users} title="No users yet" description="Create the first user to get started." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">User</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Provider</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Tags</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.items.map(user => (
                <tr
                  key={user.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/users/${user.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{user.display_name ?? user.email}</div>
                    {user.display_name && <div className="text-xs text-gray-400">{user.email}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge label={user.status} className={userStatusColor(user.status)} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{user.auth_provider ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(user.tags ?? []).map(t => (
                        <span key={t} className="text-xs bg-[#e6f4ed] text-[#00843D] px-1.5 py-0.5 rounded-full">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(user.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New User</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input placeholder="user@example.com" {...register('email')} />
              {errors.email && <p className="text-xs text-red-600">{errors.email.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input placeholder="Full Name" {...register('display_name')} />
            </div>
            <div className="space-y-1.5">
              <Label>Auth Provider</Label>
              <Select onValueChange={(v: unknown) => setValue('auth_provider', String(v) as AuthProvider)}>
                <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="pingfederate">PingFederate</SelectItem>
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
