import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rolesApi } from 'identity-web/api/roles.api'
import type { CreateRoleRequest, AssignPermissionRequest } from 'identity-web/types'

export function useRoles(params?: { page?: number; size?: number }) {
  return useQuery({
    queryKey: ['roles', params],
    queryFn: () => rolesApi.list(params),
    staleTime: 60_000,
  })
}

export function useRole(roleKey: string) {
  return useQuery({
    queryKey: ['roles', roleKey],
    queryFn: () => rolesApi.get(roleKey),
    enabled: !!roleKey,
  })
}

export function useCreateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateRoleRequest) => rolesApi.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
  })
}

export function useAddRolePermission(roleKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AssignPermissionRequest) => rolesApi.addPermission(roleKey, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles', roleKey] })
      qc.invalidateQueries({ queryKey: ['roles', roleKey, 'permissions'] })
    },
  })
}

export function useRemoveRolePermission(roleKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (permKey: string) => rolesApi.removePermission(roleKey, permKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles', roleKey] })
      qc.invalidateQueries({ queryKey: ['roles', roleKey, 'permissions'] })
    },
  })
}

export function useRolePermissions(roleKey: string) {
  return useQuery({
    queryKey: ['roles', roleKey, 'permissions'],
    queryFn: () => rolesApi.listPermissions(roleKey),
    enabled: !!roleKey,
  })
}
