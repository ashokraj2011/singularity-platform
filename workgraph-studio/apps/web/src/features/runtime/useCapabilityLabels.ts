import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchCapabilities } from '../../lib/registry'

export function useCapabilityLabels() {
  const { data = [], isLoading, isError } = useQuery({
    queryKey: ['lookup', 'capabilities', 'labels'],
    queryFn: () => fetchCapabilities(),
    staleTime: 60_000,
  })

  const labelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const capability of data) {
      const label = `${capability.name}${capability.capability_type ? ` · ${capability.capability_type}` : ''}`
      if (capability.id) map.set(capability.id, label)
      if (capability.capability_id) map.set(capability.capability_id, label)
    }
    return map
  }, [data])

  const labelForCapability = useCallback((id?: string | null) => {
    if (!id) return 'No capability'
    return labelById.get(id) ?? id
  }, [labelById])

  return { labelForCapability, isLoading, isError }
}
