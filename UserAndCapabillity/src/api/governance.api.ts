import { api } from 'identity-web/lib/api'
import type {
  Capability, PageResponse,
  GovernanceAttachment, CreateGovernedByRequest, UpdateGovernedByRequest,
} from 'identity-web/types'

// Capability Governance Model (G7) — authoring client against the IAM
// governance endpoints (G1 read/create + G7a mutate).
export const governanceApi = {
  // Attachments where `id` is the governed (operational) capability.
  listGovernedBy: (id: string, includeInactive = false) =>
    api.get<GovernanceAttachment[]>(`/capabilities/${id}/governed-by`,
      { params: includeInactive ? { include_inactive: true } : undefined }).then(r => r.data),

  // Attachments where `id` is the governing capability (a policy).
  listGoverns: (id: string) =>
    api.get<GovernanceAttachment[]>(`/capabilities/${id}/governs`).then(r => r.data),

  attach: (id: string, body: CreateGovernedByRequest) =>
    api.post<GovernanceAttachment>(`/capabilities/${id}/governed-by`, body).then(r => r.data),

  update: (id: string, attachmentId: string, body: UpdateGovernedByRequest) =>
    api.patch<GovernanceAttachment>(`/capabilities/${id}/governed-by/${attachmentId}`, body).then(r => r.data),

  deactivate: (id: string, attachmentId: string) =>
    api.post<GovernanceAttachment>(`/capabilities/${id}/governed-by/${attachmentId}/deactivate`).then(r => r.data),

  reactivate: (id: string, attachmentId: string) =>
    api.post<GovernanceAttachment>(`/capabilities/${id}/governed-by/${attachmentId}/reactivate`).then(r => r.data),

  // Governing-capability picker — capabilities with is_governing=true (G7a filter).
  listGoverningCapabilities: (params?: { page?: number; size?: number }) =>
    api.get<PageResponse<Capability>>('/capabilities',
      { params: { is_governing: true, size: 200, ...params } }).then(r => r.data),
}
