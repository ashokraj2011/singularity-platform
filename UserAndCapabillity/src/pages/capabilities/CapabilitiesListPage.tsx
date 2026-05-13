import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Layers, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { useCapabilities } from '@/hooks/useCapabilities'
import { capabilityTypeColor, capabilityTypeLabel, formatDate } from '@/lib/format'
import type { CapabilityType } from '@/types'

const TYPES: CapabilityType[] = [
  'business_capability', 'application_capability', 'shared_capability',
  'delivery_capability', 'collection_capability', 'platform_capability', 'technical_capability',
]

export function CapabilitiesListPage() {
  const navigate = useNavigate()
  const [typeFilter, setTypeFilter] = useState<string>('')
  const { data, isLoading } = useCapabilities({ capability_type: typeFilter || undefined })

  return (
    <div className="p-8">
      <PageHeader
        title="Capabilities"
        subtitle="IAM authorization references for capabilities bootstrapped in Agent & Tools"
        action={
          <a href="http://localhost:3000/capabilities" target="_blank" rel="noreferrer">
            <Button className="bg-[#00843D] hover:bg-[#006830]">
              <ExternalLink className="w-4 h-4 mr-1.5" /> Bootstrap in Agent & Tools
            </Button>
          </a>
        }
      />

      <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-[#00843D] mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-gray-900">Single owner for bootstrapping</p>
          <p className="text-sm text-gray-600 mt-0.5">
            Capability onboarding, repo/document learning, generated agents, and approval packets live in Agent & Tools.
            IAM keeps the authorization reference used for members, roles, relationships, sharing, and authz checks.
          </p>
        </div>
      </div>

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
          <EmptyState icon={Layers} title="No capability references" description="Bootstrap capabilities in Agent & Tools; IAM references will appear here for governance." />
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
    </div>
  )
}
