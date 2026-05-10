import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/StatusBadge'
import { useUser } from '@/hooks/useUsers'
import { userStatusColor, formatDateTime } from '@/lib/format'

export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const { data: user, isLoading } = useUser(userId!)

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading…</div>
  if (!user) return <div className="p-8 text-sm text-gray-500">User not found.</div>

  return (
    <div className="p-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-gray-500" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>

      <div className="flex items-start gap-4 mb-6">
        <div className="w-12 h-12 rounded-full bg-[#00843D] flex items-center justify-center text-white font-semibold text-lg">
          {(user.display_name ?? user.email)[0].toUpperCase()}
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{user.display_name ?? user.email}</h1>
          {user.display_name && <p className="text-sm text-gray-500">{user.email}</p>}
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge label={user.status} className={userStatusColor(user.status)} />
            {user.is_super_admin && (
              <StatusBadge label="Super Admin" className="bg-[#e6f4ed] text-[#00843D]" />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {[
          ['User ID', user.id],
          ['Auth Provider', user.auth_provider ?? '—'],
          ['External Subject', user.external_subject ?? '—'],
          ['Local Account', user.is_local_account ? 'Yes' : 'No'],
          ['Created', formatDateTime(user.created_at)],
          ['Updated', formatDateTime(user.updated_at)],
        ].map(([label, value]) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-400 mb-1">{label}</p>
            <p className="text-sm font-medium text-gray-900 break-all">{value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
