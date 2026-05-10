import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Membership {
  capability_id: string
  capability_name: string
  team_id: string
  team_name: string
  role_key: string
  role_name: string
  is_capability_owner: boolean
}

export interface ActiveContext {
  capabilityId: string
  capabilityName: string
  teamId: string
  teamName: string
  roleKey: string
  roleName: string
  isCapabilityOwner: boolean
}

interface ActiveContextState {
  memberships: Membership[]
  active: ActiveContext | null
  setMemberships: (m: Membership[]) => void
  setActive: (m: Membership) => void
  clear: () => void
}

export const useActiveContextStore = create<ActiveContextState>()(
  persist(
    set => ({
      memberships: [],
      active: null,
      setMemberships: memberships => set({ memberships }),
      setActive: m =>
        set({
          active: {
            capabilityId: m.capability_id,
            capabilityName: m.capability_name,
            teamId: m.team_id,
            teamName: m.team_name,
            roleKey: m.role_key,
            roleName: m.role_name,
            isCapabilityOwner: m.is_capability_owner,
          },
        }),
      clear: () => set({ memberships: [], active: null }),
    }),
    { name: 'workgraph-active-context' },
  ),
)
