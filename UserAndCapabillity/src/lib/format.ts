import type { CapabilityType, UserStatus, GrantStatus } from '@/types'

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function capabilityTypeLabel(type: CapabilityType): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function userStatusColor(status: UserStatus): string {
  const map: Record<UserStatus, string> = {
    active: 'bg-green-100 text-green-800',
    disabled: 'bg-gray-100 text-gray-600',
    invited: 'bg-blue-100 text-blue-800',
    locked: 'bg-red-100 text-red-800',
  }
  return map[status] ?? 'bg-gray-100 text-gray-600'
}

export function grantStatusColor(status: GrantStatus): string {
  const map: Record<GrantStatus, string> = {
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-yellow-100 text-yellow-800',
    revoked: 'bg-red-100 text-red-800',
  }
  return map[status] ?? 'bg-gray-100 text-gray-600'
}

export function capabilityTypeColor(type: CapabilityType): string {
  const map: Record<CapabilityType, string> = {
    business_capability: 'bg-sky-100 text-sky-800',
    application_capability: 'bg-violet-100 text-violet-800',
    shared_capability: 'bg-amber-100 text-amber-800',
    delivery_capability: 'bg-emerald-100 text-emerald-800',
    collection_capability: 'bg-pink-100 text-pink-800',
    platform_capability: 'bg-indigo-100 text-indigo-800',
    technical_capability: 'bg-slate-100 text-slate-800',
  }
  return map[type] ?? 'bg-gray-100 text-gray-600'
}
