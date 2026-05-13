import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authzApi, type AuthzCheckResponse } from '@/api/authz.api'

const schema = z.object({
  user_id: z.string().min(1),
  capability_id: z.string().min(1),
  action: z.string().min(1),
  resource_type: z.string().optional(),
  resource_id: z.string().optional(),
  requesting_capability_id: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

export function AuthzCheckPage() {
  const [result, setResult] = useState<AuthzCheckResponse | null>(null)
  const { register, handleSubmit, formState: { isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(values: FormValues) {
    try {
      const res = await authzApi.check(values)
      setResult(res)
    } catch {
      setResult({ allowed: false, reason: 'Request failed — check if the IAM service is running.' })
    }
  }

  return (
    <div className="p-8">
      <PageHeader title="Authorization Check" subtitle="Test authorization decisions in real time" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Authorization Check</h2>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>User ID *</Label>
              <Input placeholder="UUID" {...register('user_id')} />
            </div>
            <div className="space-y-1.5">
              <Label>Capability ID *</Label>
              <Input placeholder="personalization" {...register('capability_id')} />
            </div>
            <div className="space-y-1.5">
              <Label>Action *</Label>
              <Input placeholder="workflow:execute" {...register('action')} />
            </div>
            <div className="space-y-1.5">
              <Label>Resource Type</Label>
              <Input placeholder="workflow" {...register('resource_type')} />
            </div>
            <div className="space-y-1.5">
              <Label>Resource ID</Label>
              <Input placeholder="workflow-123" {...register('resource_id')} />
            </div>
            <div className="space-y-1.5">
              <Label>Requesting Capability ID (for shared access)</Label>
              <Input placeholder="Optional" {...register('requesting_capability_id')} />
            </div>
            <Button type="submit" disabled={isSubmitting} className="w-full bg-[#00843D] hover:bg-[#006830]">
              {isSubmitting ? 'Checking…' : 'Check Authorization'}
            </Button>
          </form>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Result</h2>
          {!result ? (
            <div className="flex items-center justify-center h-48 text-sm text-gray-400">
              Submit the form to see the result
            </div>
          ) : (
            <div className="space-y-4">
              <div className={`flex items-center gap-3 p-4 rounded-xl ${result.allowed ? 'bg-green-50' : 'bg-red-50'}`}>
                {result.allowed ? (
                  <ShieldCheck className="w-8 h-8 text-green-600 shrink-0" />
                ) : (
                  <ShieldX className="w-8 h-8 text-red-600 shrink-0" />
                )}
                <div>
                  <p className={`text-lg font-bold ${result.allowed ? 'text-green-700' : 'text-red-700'}`}>
                    {result.allowed ? 'ALLOWED' : 'DENIED'}
                  </p>
                  {result.reason && <p className="text-sm text-gray-600 mt-0.5">{result.reason}</p>}
                </div>
              </div>

              {result.roles && result.roles.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Roles</p>
                  <div className="flex flex-wrap gap-1">
                    {result.roles.map(r => (
                      <span key={r} className="font-mono text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">{r}</span>
                    ))}
                  </div>
                </div>
              )}

              {result.permissions && result.permissions.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Permissions</p>
                  <div className="flex flex-wrap gap-1">
                    {result.permissions.map(p => (
                      <span key={p} className="font-mono text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">{p}</span>
                    ))}
                  </div>
                </div>
              )}

              {result.source && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">Source</p>
                  <span className="font-mono text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">{result.source}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
