import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'

/**
 * Shared access to the Work Item's working specification version — the one artifact Analysis,
 * Requirements and Design all edit (different sections of the same versioned package). Resolves the
 * editable draft (or the active/newest version to read), exposes the body, and patches one section
 * through the existing optimistic-concurrency route.
 */
const HEADER_KEYS = new Set(['schemaVersion', 'workItem', 'version'])

export function useSpecDraft(workItemId: string) {
  const qc = useQueryClient()
  const listQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const items: any[] = listQ.data?.items ?? []
  const draft = items.find((v) => v.status === 'DRAFT' || v.status === 'CHANGES_REQUESTED')
  const currentId = draft?.id ?? listQ.data?.activeVersionId ?? items[0]?.id ?? null

  const versionQ = useQuery<any>({ queryKey: ['spec-version', workItemId, currentId], enabled: !!currentId, queryFn: () => api.get(`/work-items/${workItemId}/specifications/${currentId}`).then((r) => r.data) })
  const pkg = versionQ.data
  const header = (pkg?.version ?? {}) as { status?: string; revision?: number; number?: number }
  const editable = header.status === 'DRAFT' || header.status === 'CHANGES_REQUESTED'
  const body = useMemo(() => { const b: any = {}; if (pkg) for (const [k, v] of Object.entries(pkg)) if (!HEADER_KEYS.has(k)) b[k] = v; return b }, [pkg])

  const refetch = () => { qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] }); qc.invalidateQueries({ queryKey: ['spec-version', workItemId] }) }
  const patchMut = useMutation({
    mutationFn: (sectionPatch: Record<string, unknown>) => api.patch(`/work-items/${workItemId}/specifications/${currentId}`, { ...sectionPatch, expectedRevision: header.revision ?? 1 }).then((r) => r.data),
    onSuccess: refetch,
  })
  const createMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications`, {}).then((r) => r.data), onSuccess: refetch })

  return { loading: listQ.isLoading, pkg, body, header, editable, currentId, hasSpec: !!pkg, patchMut, createMut }
}
