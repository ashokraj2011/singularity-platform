import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, UsersRound } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { TagsInput } from '@/components/TagsInput'
import { MetadataEditor } from '@/components/MetadataEditor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTeams, useCreateTeam } from '@/hooks/useTeams'
import { formatDate } from '@/lib/format'

const schema = z.object({
  team_key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  bu_key: z.string().optional(),
  parent_team_id: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

export function TeamsListPage() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const { data, isLoading } = useTeams()
  const createTeam = useCreateTeam()

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
    await createTeam.mutateAsync({ ...values, tags, metadata })
    handleClose()
  }

  return (
    <div className="p-8">
      <PageHeader
        title="Teams"
        subtitle="Manage teams and their capability roles"
        action={
          <Button onClick={() => setOpen(true)} className="bg-[#00843D] hover:bg-[#006830]">
            <Plus className="w-4 h-4 mr-1.5" /> New Team
          </Button>
        }
      />

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : !data?.items.length ? (
        <EmptyState icon={UsersRound} title="No teams yet" description="Create the first team." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.items.map(team => (
            <div
              key={team.id}
              className="bg-white rounded-xl border border-gray-200 p-5 cursor-pointer hover:border-[#00843D]/40 hover:shadow-sm transition-all"
              onClick={() => navigate(`/teams/${team.id}`)}
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-sky-50 flex items-center justify-center shrink-0">
                  <UsersRound className="w-4 h-4 text-sky-600" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{team.name}</p>
                  <p className="font-mono text-xs text-gray-400 mt-0.5">{team.team_key}</p>
                  {team.description && (
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">{team.description}</p>
                  )}
                  {(team.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {team.tags.map(t => (
                        <span key={t} className="text-xs bg-[#e6f4ed] text-[#00843D] px-1.5 py-0.5 rounded-full">{t}</span>
                      ))}
                    </div>
                  )}
                  {team.parent_team_id && (
                    <p className="text-xs text-gray-400 mt-1">
                      Sub-team of <span className="font-mono">{team.parent_team_id.slice(0, 8)}…</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400">
                Created {formatDate(team.created_at)}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Team</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label>Key *</Label>
              <Input placeholder="ai-platform-team" {...register('team_key')} />
              {errors.team_key && <p className="text-xs text-red-600">{errors.team_key.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="AI Platform Team" {...register('name')} />
              {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Optional" {...register('description')} />
            </div>
            <div className="space-y-1.5">
              <Label>Business Unit Key</Label>
              <Input placeholder="enterprise-technology" {...register('bu_key')} />
            </div>
            <div className="space-y-1.5">
              <Label>Parent Team</Label>
              <Select onValueChange={(v: unknown) => setValue('parent_team_id', String(v))}>
                <SelectTrigger><SelectValue placeholder="None (top-level)" /></SelectTrigger>
                <SelectContent>
                  {data?.items.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
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
