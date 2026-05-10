import { useState } from 'react'
import { Search, Key } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { Input } from '@/components/ui/input'
import { usePermissions } from '@/hooks/usePermissions'

export function PermissionsPage() {
  const [search, setSearch] = useState('')
  const { data, isLoading } = usePermissions({ size: 500 })

  const filtered = data?.items.filter(p =>
    p.permission_key.toLowerCase().includes(search.toLowerCase()) ||
    p.category?.toLowerCase().includes(search.toLowerCase())
  ) ?? []

  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, p) => {
    const cat = p.category ?? 'other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(p)
    return acc
  }, {})

  return (
    <div className="p-8">
      <PageHeader title="Permissions" subtitle="All available system permissions" />

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input className="pl-9" placeholder="Search permissions…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400">Loading…</div>
      ) : !filtered.length ? (
        <EmptyState icon={Key} title="No permissions found" />
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).sort().map(([cat, perms]) => (
            <div key={cat} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider">{cat}</p>
              </div>
              <div className="divide-y divide-gray-50">
                {perms.map(p => (
                  <div key={p.id} className="px-4 py-2.5 flex items-center justify-between">
                    <span className="font-mono text-xs text-gray-800">{p.permission_key}</span>
                    {p.description && <span className="text-xs text-gray-400">{p.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
