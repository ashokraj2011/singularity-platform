import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList, Info } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { RolePicker, SkillPicker, TeamPicker, UserPicker } from '../../components/lookup/EntityPickers'

export type RuntimeInput = {
  id: string
  key: string
  scope: 'vars' | 'globals' | 'params'
  reference: string
  label: string
  description?: string
  type?: string
  kind: 'text' | 'number' | 'boolean' | 'json' | 'user' | 'team' | 'role' | 'skill'
  required: boolean
  defaultValue?: unknown
  nodes: Array<{ nodeId: string; nodeLabel: string; nodeType: string; field: string }>
}

export type RuntimeInputValues = {
  vars: Record<string, unknown>
  globals: Record<string, unknown>
  params: Record<string, unknown>
}

const emptyValues = (): RuntimeInputValues => ({ vars: {}, globals: {}, params: {} })

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2) } catch { return '' }
  }
  return String(value)
}

function seedValues(inputs: RuntimeInput[], initialVars: Record<string, unknown>): RuntimeInputValues {
  const next = emptyValues()
  for (const input of inputs) {
    const initial = input.scope === 'vars' ? initialVars[input.key] : undefined
    const value = initial !== undefined ? initial : input.defaultValue
    if (value !== undefined) next[input.scope][input.key] = value
  }
  return next
}

export function runtimeInputsReady(inputs: RuntimeInput[], values: RuntimeInputValues): boolean {
  return inputs.every(input => !input.required || hasValue(values[input.scope][input.key]) || input.defaultValue !== undefined)
}

export function RuntimeInputsForm({
  workflowId,
  initialVars = {},
  values,
  onChange,
  onReadyChange,
}: {
  workflowId: string
  initialVars?: Record<string, unknown>
  values: RuntimeInputValues
  onChange: (values: RuntimeInputValues) => void
  onReadyChange?: (ready: boolean) => void
}) {
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({})
  const seededKey = `${workflowId}:${JSON.stringify(initialVars)}`
  const lastSeededKey = useRef('')
  const inputsQuery = useQuery<{ inputs?: RuntimeInput[] }>({
    queryKey: ['workflow-runtime-inputs', workflowId],
    queryFn: () => api.get(`/workflow-templates/${workflowId}/runtime-inputs`).then(r => r.data),
    staleTime: 30_000,
  })
  const inputs = inputsQuery.data?.inputs ?? []

  useEffect(() => {
    if (!inputsQuery.isSuccess || lastSeededKey.current === seededKey) return
    lastSeededKey.current = seededKey
    onChange(seedValues(inputs, initialVars))
  }, [initialVars, inputs, inputsQuery.isSuccess, onChange, seededKey])

  const ready = useMemo(() => runtimeInputsReady(inputs, values) && Object.keys(jsonErrors).length === 0, [inputs, values, jsonErrors])
  useEffect(() => onReadyChange?.(ready), [onReadyChange, ready])

  const update = (input: RuntimeInput, next: unknown) => {
    onChange({ ...values, [input.scope]: { ...values[input.scope], [input.key]: next } })
  }

  const renderControl = (input: RuntimeInput) => {
    const current = values[input.scope][input.key]
    const textValue = displayValue(current)
    const pickerProps = {
      value: textValue,
      onChange: (next: string) => update(input, next),
      placeholder: input.required ? `Enter ${input.label.toLowerCase()}` : 'Optional',
    }
    if (input.kind === 'role') return <RolePicker {...pickerProps} placeholder="Select a role…" />
    if (input.kind === 'user') return <UserPicker {...pickerProps} placeholder="Select a user…" />
    if (input.kind === 'team') return <TeamPicker {...pickerProps} placeholder="Select a team…" />
    if (input.kind === 'skill') return <SkillPicker {...pickerProps} placeholder="Select a skill…" />
    if (input.kind === 'boolean') {
      return (
        <select value={textValue} onChange={event => update(input, event.target.value === '' ? undefined : event.target.value === 'true')} style={controlStyle}>
          <option value="">Select…</option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      )
    }
    if (input.kind === 'number') {
      return <input type="number" value={textValue} placeholder={pickerProps.placeholder} onChange={event => update(input, event.target.value === '' ? undefined : Number(event.target.value))} style={controlStyle} />
    }
    if (input.kind === 'json') {
      return (
        <>
          <textarea
            value={textValue}
            onChange={event => {
              const raw = event.target.value
              if (!raw.trim()) {
                setJsonErrors(previous => { const next = { ...previous }; delete next[input.id]; return next })
                update(input, undefined)
                return
              }
              try {
                const parsed = JSON.parse(raw)
                setJsonErrors(previous => { const next = { ...previous }; delete next[input.id]; return next })
                update(input, parsed)
              } catch {
                setJsonErrors(previous => ({ ...previous, [input.id]: 'Enter valid JSON.' }))
              }
            }}
            placeholder='{"key":"value"}'
            style={{ ...controlStyle, minHeight: 64, resize: 'vertical' }}
          />
          {jsonErrors[input.id] && <p style={errorTextStyle}>{jsonErrors[input.id]}</p>}
        </>
      )
    }
    return <input type="text" value={textValue} placeholder={pickerProps.placeholder} onChange={event => update(input, event.target.value)} style={controlStyle} />
  }

  return (
    <section style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 8 }}>
        <ClipboardList size={16} style={{ color: '#7c3aed', marginTop: 1 }} />
        <div>
          <h3 style={titleStyle}>Run inputs</h3>
          <p style={mutedStyle}>Values used by nodes across this workflow are captured once and resolved per node at runtime.</p>
        </div>
      </div>
      {inputsQuery.isLoading ? (
        <p style={mutedStyle}>Inspecting workflow nodes for runtime inputs…</p>
      ) : inputsQuery.isError ? (
        <p style={errorTextStyle}>Could not inspect node inputs. Refresh before starting this workflow.</p>
      ) : inputs.length === 0 ? (
        <p style={mutedStyle}>This workflow has no launch-time placeholders. WorkItem and event context will still be available to nodes.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {inputs.map(input => (
            <div key={input.id} style={inputRowStyle}>
              <div style={{ minWidth: 0 }}>
                <label style={labelStyle}>{input.label}{input.required ? ' *' : ''}</label>
                <p style={referenceStyle}><code>{`{{${input.reference}}}`}</code> · {input.scope}</p>
                {input.description && <p style={mutedStyle}>{input.description}</p>}
                <p style={usedByStyle}>
                  <Info size={11} /> Used by {input.nodes.length > 0 ? input.nodes.map(node => `${node.nodeLabel} (${node.field})`).join(', ') : 'workflow variable'}
                </p>
              </div>
              <div style={{ minWidth: 220 }}>{renderControl(input)}</div>
            </div>
          ))}
        </div>
      )}
      {!ready && inputs.length > 0 && <p style={{ ...errorTextStyle, marginTop: 9 }}>Complete the required run inputs before starting.</p>}
    </section>
  )
}

const sectionStyle = { padding: 14, borderRadius: 14, border: '1px solid rgba(124,58,237,0.22)', background: 'rgba(124,58,237,0.035)' }
const titleStyle = { margin: 0, color: '#0f172a', fontSize: 15, fontWeight: 900 }
const mutedStyle = { margin: '3px 0 0', color: '#64748b', fontSize: 11, lineHeight: 1.45 }
const labelStyle = { display: 'block', color: '#0f172a', fontSize: 12, fontWeight: 900 }
const referenceStyle = { margin: '3px 0 0', color: '#7c3aed', fontSize: 10 }
const usedByStyle = { display: 'flex', alignItems: 'center', gap: 4, margin: '6px 0 0', color: '#64748b', fontSize: 10, lineHeight: 1.35 }
const errorTextStyle = { margin: '4px 0 0', color: '#b91c1c', fontSize: 11 }
const inputRowStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(200px, 0.8fr)', gap: 12, alignItems: 'start', padding: 10, borderRadius: 10, background: '#fff', border: '1px solid #e5e7eb' }
const controlStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '8px 10px', minHeight: 36, borderRadius: 8, border: '1px solid #dbe4ec', background: '#fff', color: '#0f172a', fontSize: 12, fontFamily: 'inherit' }
