import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { capabilitiesApi } from '@/api/capabilities.api'
import type {
  CreateCapabilityRequest,
  CreateCapabilityRelationshipRequest,
  AddCapabilityMemberRequest,
} from '@/types'

export function useCapabilities(params?: { page?: number; size?: number; capability_type?: string }) {
  return useQuery({
    queryKey: ['capabilities', params],
    queryFn: () => capabilitiesApi.list(params),
    staleTime: 30_000,
  })
}

export function useCapability(id: string) {
  return useQuery({
    queryKey: ['capabilities', id],
    queryFn: () => capabilitiesApi.get(id),
    enabled: !!id,
  })
}

export function useCapabilityRelationships(id: string) {
  return useQuery({
    queryKey: ['capabilities', id, 'relationships'],
    queryFn: () => capabilitiesApi.listRelationships(id),
    enabled: !!id,
  })
}

export function useCapabilityMembers(id: string) {
  return useQuery({
    queryKey: ['capabilities', id, 'members'],
    queryFn: () => capabilitiesApi.listMembers(id),
    enabled: !!id,
  })
}

export function useCreateCapability() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCapabilityRequest) => capabilitiesApi.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  })
}

export function useAddCapabilityRelationship(capabilityId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateCapabilityRelationshipRequest) =>
      capabilitiesApi.addRelationship(capabilityId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities', capabilityId, 'relationships'] }),
  })
}

export function useAddCapabilityMember(capabilityId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddCapabilityMemberRequest) =>
      capabilitiesApi.addMember(capabilityId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities', capabilityId, 'members'] }),
  })
}
