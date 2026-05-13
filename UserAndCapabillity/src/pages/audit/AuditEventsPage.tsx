import { useState } from 'react'
import { ClipboardList, ChevronDown, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuditEvents } from '@/hooks/useAuditEvents'
import { formatDateTime } from '@/lib/format'

export function AuditEventsPage() {
  const [eventType, setEventType] = useState('')
  const [capabilityId, setCapabilityId] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { data, isLoading } = useAuditEvents({
    size: 50,
    event_type: eventType || undefined,
    capability_id: capabilityId || undefined,
  })

  return (
    <div className="p-8">
      <PageHeader title="Audit" subtitle="Complete trail of identity and access actions" />

      <div className="flex gap-3 mb-4">
        <div className="flex-1 space-y-1.5">
          <Label className="text-xs">Event Type</Label>
          <Input placeholder="capability_created" value={eventType} onChange={e => setEventType(e.target.value)} />
        </div>
        <div className="flex-1 space-y-1.5">
          <Label className="text-xs">Capability ID</Label>
          <Input placeholder="personalization" value={capabilityId} onChange={e => setCapabilityId(e.target.value)} />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading…</div>
        ) : !data?.items.length ? (
          <EmptyState icon={ClipboardList} title="No audit events" description="Events appear here as actions are taken." />
        ) : (
          <div className="divide-y divide-gray-50">
            {data.items.map(ev => (
              <div key={ev.id}>
                <div
                  className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                >
                  <div className="text-gray-400 shrink-0">
                    {expandedId === ev.id
                      ? <ChevronDown className="w-3.5 h-3.5" />
                      : <ChevronRight className="w-3.5 h-3.5" />}
                  </div>
                  <span className="font-mono text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded whitespace-nowrap">
                    {ev.event_type}
                  </span>
                  {ev.capability_id && (
                    <span className="text-sm text-gray-600">{ev.capability_id}</span>
                  )}
                  {ev.target_type && (
                    <span className="text-xs text-gray-400">{ev.target_type}: {ev.target_id}</span>
                  )}
                  <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">{formatDateTime(ev.created_at)}</span>
                </div>
                {expandedId === ev.id && (
                  <div className="px-10 py-3 bg-gray-50 border-t border-gray-100">
                    <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
                      {ev.actor_user_id && (
                        <div>
                          <p className="text-gray-400">Actor</p>
                          <p className="font-mono text-gray-700 mt-0.5">{ev.actor_user_id}</p>
                        </div>
                      )}
                      {ev.ip_address && (
                        <div>
                          <p className="text-gray-400">IP</p>
                          <p className="font-mono text-gray-700 mt-0.5">{ev.ip_address}</p>
                        </div>
                      )}
                    </div>
                    {Object.keys(ev.payload).length > 0 && (
                      <div>
                        <p className="text-xs text-gray-400 mb-1">Payload</p>
                        <pre className="text-xs bg-white rounded-lg border border-gray-200 p-3 overflow-x-auto text-gray-700">
                          {JSON.stringify(ev.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
