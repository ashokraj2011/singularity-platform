import axios, { type AxiosRequestConfig } from 'axios'
import { useAuthStore } from '../store/auth.store'
import { api } from './api'

export type RegistryAgent = {
  id: string
  name: string
  description?: string
  model?: string
  capabilities?: string[]
}

export type RegistryToolAction = {
  id: string
  name: string
  inputSchema?: unknown
  outputSchema?: unknown
}

export type RegistryTool = {
  id: string
  name: string
  description?: string
  riskLevel?: string
  requiresApproval?: boolean
  actions?: RegistryToolAction[]
}

const AGENT_REGISTRY_URL = (import.meta.env.VITE_AGENT_REGISTRY_URL as string | undefined)?.replace(/\/+$/, '')
const TOOL_REGISTRY_URL = (import.meta.env.VITE_TOOL_REGISTRY_URL as string | undefined)?.replace(/\/+$/, '')

function authConfig(): AxiosRequestConfig {
  const token = useAuthStore.getState().token
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {}
}

function unwrap<T>(data: unknown, key?: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (key && Array.isArray(obj[key])) return obj[key] as T[]
    if (Array.isArray(obj.content)) return obj.content as T[]
    if (Array.isArray(obj.items)) return obj.items as T[]
  }
  return []
}

// ─── Agents ───────────────────────────────────────────────────────────────
// M10 — fetchAgents now hits the federated /api/lookup/agent-templates proxy
// which forwards the user JWT to agent-and-tools. The legacy
// VITE_AGENT_REGISTRY_URL escape hatch remains for power users who want to
// bypass the proxy (e.g. talking directly to a remote agent-runtime).

export async function fetchAgents(capabilityId?: string): Promise<RegistryAgent[]> {
  if (AGENT_REGISTRY_URL) {
    const res = await axios.get(`${AGENT_REGISTRY_URL}/agents`, authConfig())
    return unwrap<RegistryAgent>(res.data, 'agents')
  }
  const params: Record<string, string> = { size: '200' }
  if (capabilityId) params.capability_id = capabilityId
  const res = await api.get('/lookup/agent-templates', { params })
  return unwrap<RegistryAgent>(res.data, 'items')
}

export async function fetchAgent(id: string): Promise<RegistryAgent | null> {
  if (AGENT_REGISTRY_URL) {
    const res = await axios.get(`${AGENT_REGISTRY_URL}/agents/${id}`, authConfig())
    return res.data as RegistryAgent
  }
  // No single-template endpoint on the proxy yet — list and find. Templates
  // are usually small in number; revisit if it gets noisy.
  const res = await api.get('/lookup/agent-templates', { params: { size: 200 } })
  const all = unwrap<RegistryAgent>(res.data, 'items')
  return all.find(a => a.id === id) ?? null
}

// ─── Tools ────────────────────────────────────────────────────────────────
// M10 — fetchTools now hits /api/lookup/tools (federated to tool-service).

export async function fetchTools(capabilityId?: string): Promise<RegistryTool[]> {
  if (TOOL_REGISTRY_URL) {
    const res = await axios.get(`${TOOL_REGISTRY_URL}/tools`, authConfig())
    return unwrap<RegistryTool>(res.data, 'tools')
  }
  const params: Record<string, string> = { size: '200', risk_max: 'high' }
  if (capabilityId) params.capability_id = capabilityId
  const res = await api.get('/lookup/tools', { params })
  // tool-service shape uses tool_name; map to id/name for the picker.
  const items = unwrap<Record<string, unknown>>(res.data, 'items')
  return items.map((t) => ({
    id:               String(t.tool_name ?? t.name ?? ''),
    name:             String(t.tool_name ?? t.name ?? ''),
    description:      (t.description as string | undefined) ?? undefined,
    riskLevel:        (t.risk_level as string | undefined)?.toUpperCase(),
    requiresApproval: Boolean(t.requires_approval),
  }))
}

export async function fetchTool(id: string): Promise<RegistryTool | null> {
  if (TOOL_REGISTRY_URL) {
    const res = await axios.get(`${TOOL_REGISTRY_URL}/tools/${id}`, authConfig())
    return res.data as RegistryTool
  }
  const all = await fetchTools()
  return all.find(t => t.id === id || t.name === id) ?? null
}

// ─── M10 — extra reference-data lookups for picker UIs ────────────────────

export type LookupTeam = { id: string; name: string; bu_id?: string }
export type LookupCapability = {
  id: string
  capability_id?: string
  name: string
  capability_type?: string
  status?: string
  source?: 'iam' | 'agent-runtime' | string
}
export type LookupUser = { id: string; email: string; display_name?: string; displayName?: string }
export type LookupRole = { id: string; role_key: string; name: string }
export type LookupSkill = { id: string; skill_key?: string; name: string }
export type LookupBusinessUnit = { id: string; bu_key: string; name: string }
export type LookupPromptProfile = { id: string; name: string; capabilityId?: string; version?: number }
export type LookupMcpServer = { id: string; base_url: string; status: string }

async function lookupList<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T[]> {
  const cleaned: Record<string, string> = { size: '200' }
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') cleaned[k] = v
  const res = await api.get(`/lookup/${path}`, { params: cleaned })
  return unwrap<T>(res.data, 'items')
}

export const fetchTeams        = (q?: string)                 => lookupList<LookupTeam>('teams', { q })
export const fetchCapabilities = (q?: string)                 => lookupList<LookupCapability>('capabilities', { q })
export const fetchUsers        = (filter: { team_id?: string; capability_id?: string; q?: string } = {}) =>
                                                                  lookupList<LookupUser>('users', filter)
export const fetchRoles        = ()                           => lookupList<LookupRole>('roles')
export const fetchSkills       = ()                           => lookupList<LookupSkill>('skills')
export const fetchBusinessUnits = ()                          => lookupList<LookupBusinessUnit>('business-units')
export const fetchPromptProfiles = (capabilityId?: string)    => lookupList<LookupPromptProfile>('prompt-profiles', { capability_id: capabilityId })
export const fetchMcpServers   = (capabilityId: string)       => lookupList<LookupMcpServer>('mcp-servers', { capability_id: capabilityId })

export const registrySource = {
  agents: AGENT_REGISTRY_URL ? 'external' : 'internal',
  tools: TOOL_REGISTRY_URL ? 'external' : 'internal',
} as const
