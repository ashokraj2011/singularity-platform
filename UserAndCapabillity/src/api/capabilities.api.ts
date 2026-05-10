import { api } from '@/lib/api'
import type {
  Capability, CreateCapabilityRequest,
  CapabilityRelationship, CreateCapabilityRelationshipRequest,
  CapabilityMembership, AddCapabilityMemberRequest,
  PageResponse,
} from '@/types'

export const capabilitiesApi = {
  list: (params?: { page?: number; size?: number; capability_type?: string }) =>
    api.get<PageResponse<Capability>>('/capabilities', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<Capability>(`/capabilities/${id}`).then(r => r.data),
  create: (body: CreateCapabilityRequest) =>
    api.post<Capability>('/capabilities', body).then(r => r.data),
  update: (id: string, body: Partial<CreateCapabilityRequest>) =>
    api.patch<Capability>(`/capabilities/${id}`, body).then(r => r.data),

  listRelationships: (id: string) =>
    api.get<CapabilityRelationship[]>(`/capabilities/${id}/relationships`).then(r => r.data),
  addRelationship: (id: string, body: CreateCapabilityRelationshipRequest) =>
    api.post<CapabilityRelationship>(`/capabilities/${id}/relationships`, body).then(r => r.data),

  listMembers: (id: string) =>
    api.get<CapabilityMembership[]>(`/capabilities/${id}/members`).then(r => r.data),
  addMember: (id: string, body: AddCapabilityMemberRequest) =>
    api.post<CapabilityMembership>(`/capabilities/${id}/members`, body).then(r => r.data),
}
