/**
 * Federated entity pickers — one component per entity type. Each renders a
 * native <select> backed by the workgraph /api/lookup/* proxy (which forwards
 * the user's JWT to IAM / agent-and-tools).
 *
 * Pickers always use the same compact style so they slot into the workflow
 * NodeInspector, Workflow create modal, Artifact editor, etc. Each accepts
 * an optional `placeholder` for the empty-value option, an optional
 * `capabilityId` for entity types that scope by capability (users, mcp
 * servers), and an optional `allowFreeText` flag — when set, a tiny "or
 * type…" toggle lets the user fall through to a raw input (used for
 * `{{vars.x}}` runtime bindings in the assignment block).
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  fetchUsers, fetchTeams, fetchRoles, fetchSkills, fetchCapabilities,
} from '../../lib/registry'
import { useActiveContextStore } from '../../store/activeContext.store'

// ─── shared styling (matches NodeInspector inputs) ──────────────────────────

const pickerStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8, padding: '6px 10px',
  fontSize: 11, color: '#e2e8f0',
  outline: 'none', appearance: 'none', cursor: 'pointer',
}

const optionStyle: CSSProperties = { background: '#0f172a' }
const hintStyle:   CSSProperties = { fontSize: 9, color: '#475569', marginTop: 4 }

interface BaseProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

// ─── CapabilityPicker — active-context-aware ────────────────────────────────
//
// Returns the union of the user's memberships (when known) intersected with
// the federated lookup. Auto-fills the active-context capability when the
// caller starts empty.

interface CapabilityPickerProps extends BaseProps {
  /** When true (default), filter to capabilities the user has a membership in. */
  filterToMemberships?: boolean
  /** Auto-default the value to the active-context capability when empty. */
  autoDefault?: boolean
  hint?: string
}

export function CapabilityPicker({ value, onChange, placeholder, filterToMemberships = true, autoDefault = true, hint, disabled }: CapabilityPickerProps) {
  const memberships = useActiveContextStore(s => s.memberships)
  const active      = useActiveContextStore(s => s.active)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['lookup', 'capabilities'],
    queryFn:  () => fetchCapabilities(),
    staleTime: 30_000,
  })
  const all = data ?? []
  const allowed = new Set(memberships.map(m => m.capability_id))
  const isMembershipCapability = (id: string, capabilityId?: string) =>
    allowed.has(id) || (capabilityId ? allowed.has(capabilityId) : false)
  const caps = filterToMemberships && memberships.length > 0
    ? all.filter(c => isMembershipCapability(c.id, c.capability_id) || c.source === 'agent-runtime')
    : all
  useEffect(() => {
    if (autoDefault && !value && active?.capabilityId && caps.some(c => c.id === active.capabilityId)) {
      onChange(active.capabilityId)
    }
  }, [autoDefault, value, active?.capabilityId, caps, onChange])
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading capabilities…' : isError ? 'Failed to load' : caps.length === 0 ? 'No capabilities' : placeholder ?? 'Select a capability…'}
        </option>
        {caps.map(c => (
          <option key={c.id} value={c.id} style={optionStyle}>
            {c.name}{c.capability_type ? ` · ${c.capability_type}` : ''}{c.source === 'agent-runtime' ? ' · Agent & Tools' : ''}
          </option>
        ))}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── UserPicker ─────────────────────────────────────────────────────────────

interface UserPickerProps extends BaseProps {
  teamId?: string
  capabilityId?: string
  hint?: string
  /** Emit user id (default), email, or display_name. */
  emit?: 'id' | 'email' | 'name'
}

export function UserPicker({ value, onChange, placeholder, teamId, capabilityId, hint, disabled, emit = 'id' }: UserPickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['lookup', 'users', teamId ?? '', capabilityId ?? ''],
    queryFn: () => fetchUsers({ team_id: teamId, capability_id: capabilityId }),
    staleTime: 30_000,
  })
  const users = data ?? []
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading users…' : isError ? 'Failed to load' : placeholder ?? 'Select a user…'}
        </option>
        {users.map(u => {
          const v = emit === 'email' ? u.email
                  : emit === 'name'  ? (u.display_name ?? u.displayName ?? u.email)
                  :                    u.id
          return (
            <option key={u.id} value={v} style={optionStyle}>
              {u.display_name ?? u.displayName ?? u.email} · {u.email}
            </option>
          )
        })}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── TeamPicker ─────────────────────────────────────────────────────────────

interface TeamPickerProps extends BaseProps {
  /** When emit === 'name', `value` and onChange use the team name; otherwise team id. */
  emit?: 'id' | 'name'
  hint?: string
}

export function TeamPicker({ value, onChange, placeholder, emit = 'id', hint, disabled }: TeamPickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['lookup', 'teams'],
    queryFn:  () => fetchTeams(),
    staleTime: 60_000,
  })
  const teams = data ?? []
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading teams…' : isError ? 'Failed to load' : placeholder ?? 'Select a team…'}
        </option>
        {teams.map(t => (
          <option key={t.id} value={emit === 'name' ? t.name : t.id} style={optionStyle}>
            {t.name}
          </option>
        ))}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── RolePicker ─────────────────────────────────────────────────────────────

interface RolePickerProps extends BaseProps {
  /** Emit role_key (default — what assignment routing uses) or id. */
  emit?: 'key' | 'id'
  hint?: string
}

export function RolePicker({ value, onChange, placeholder, emit = 'key', hint, disabled }: RolePickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['lookup', 'roles'],
    queryFn:  () => fetchRoles(),
    staleTime: 60_000,
  })
  const roles = data ?? []
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading roles…' : isError ? 'Failed to load' : placeholder ?? 'Select a role…'}
        </option>
        {roles.map(r => (
          <option key={r.id ?? r.role_key} value={emit === 'id' ? (r.id ?? r.role_key) : r.role_key} style={optionStyle}>
            {r.name} · {r.role_key}
          </option>
        ))}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── SkillPicker ────────────────────────────────────────────────────────────

interface SkillPickerProps extends BaseProps {
  emit?: 'key' | 'id'
  hint?: string
}

export function SkillPicker({ value, onChange, placeholder, emit = 'key', hint, disabled }: SkillPickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['lookup', 'skills'],
    queryFn:  () => fetchSkills(),
    staleTime: 60_000,
  })
  const skills = data ?? []
  // /skills can be empty in dev — give the user a way to type if so.
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading skills…' : isError ? 'Failed to load' : skills.length === 0 ? 'No skills registered' : placeholder ?? 'Select a skill…'}
        </option>
        {skills.map(s => (
          <option key={s.id ?? s.skill_key ?? s.name} value={emit === 'id' ? (s.id ?? '') : (s.skill_key ?? s.name)} style={optionStyle}>
            {s.name}
          </option>
        ))}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── ConnectorPicker ────────────────────────────────────────────────────────

interface LookupConnector {
  id: string
  name: string
  type?: string
  archivedAt?: string | null
}

interface ConnectorPickerProps extends BaseProps {
  /** Filter to a connector type (e.g. only show SLACK or HTTP connectors). */
  type?: string
  hint?: string
}

export function ConnectorPicker({ value, onChange, placeholder, type, hint, disabled }: ConnectorPickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['connectors', 'live'],
    queryFn: () => api.get('/connectors').then(r => r.data as LookupConnector[]),
    staleTime: 30_000,
  })
  const all  = data ?? []
  const list = all.filter(c => !c.archivedAt && (!type || c.type === type))
  return (
    <div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        style={pickerStyle}
      >
        <option value="" style={optionStyle}>
          {isLoading ? 'Loading connectors…' : isError ? 'Failed to load' : list.length === 0 ? 'No connectors registered' : placeholder ?? 'Select a connector…'}
        </option>
        {list.map(c => (
          <option key={c.id} value={c.id} style={optionStyle}>
            {c.name}{c.type ? ` · ${c.type}` : ''}
          </option>
        ))}
      </select>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  )
}

// ─── PickerOrText — combo for fields that accept either a literal id or a
//     {{vars.x}} runtime binding. Picker fills the literal; the user can
//     still toggle to "type" and put a template expression in the input. ───

interface PickerOrTextProps {
  value: string
  onChange: (v: string) => void
  /** Render-prop for the picker UI. */
  picker: (write: (v: string) => void) => React.ReactNode
  placeholder?: string
  inputStyle?: CSSProperties
}

export function PickerOrText({ value, onChange, picker, placeholder, inputStyle }: PickerOrTextProps) {
  const looksLikeTemplate = value.includes('{{') || value.includes('}}')
  const [mode, setMode] = useState<'pick' | 'type'>(looksLikeTemplate || value === '' ? (looksLikeTemplate ? 'type' : 'pick') : 'type')
  // If the value changes externally to a template, switch to "type" mode so
  // the user sees what's there.
  useEffect(() => {
    if (looksLikeTemplate && mode !== 'type') setMode('type')
  }, [looksLikeTemplate, mode])
  return (
    <div>
      {mode === 'pick'
        ? picker(v => onChange(v))
        : (
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            style={inputStyle ?? pickerStyle}
          />
        )}
      <button
        type="button"
        onClick={() => setMode(mode === 'pick' ? 'type' : 'pick')}
        style={{
          marginTop: 4,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 9, color: '#64748b', textDecoration: 'underline',
        }}
      >
        {mode === 'pick' ? 'or type a value / variable…' : 'pick from list…'}
      </button>
    </div>
  )
}
