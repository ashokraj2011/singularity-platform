import { useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from 'identity-web/components/ui/button'
import { Input } from 'identity-web/components/ui/input'
import { Label } from 'identity-web/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'identity-web/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'identity-web/components/ui/select'
import { StatusBadge } from 'identity-web/components/StatusBadge'
import {
  useGovernedBy, useGoverningCapabilities, useAttachGovernance,
  useUpdateGovernance, useDeactivateGovernance, useReactivateGovernance,
} from 'identity-web/hooks/useGovernance'
import {
  GOVERNANCE_MODES, GOVERNANCE_SCOPES,
  type GovernanceAttachment, type GovernanceMode, type GovernanceScope,
} from 'identity-web/types'

const MODE_CLASS: Record<GovernanceMode, string> = {
  ADVISORY: 'bg-sky-100 text-sky-700',
  REQUIRED: 'bg-amber-100 text-amber-700',
  BLOCKING: 'bg-red-100 text-red-700',
}

function errMessage(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return e instanceof Error ? e.message : 'Request failed'
}

type FormState = {
  governing_capability_id: string
  mode: GovernanceMode
  scope: GovernanceScope
  target_kind: string
  target_key: string
  priority: string
  waiver_allowed: boolean
  // G9 — primary policy content, edited as link-or-type (becomes the
  // `policy` promptLayer). The rest of contributions stays as advanced JSON.
  policyMode: 'type' | 'link'
  policyText: string
  policySourceUrl: string
  contributions: string
}

const EMPTY_FORM: FormState = {
  governing_capability_id: '', mode: 'ADVISORY', scope: 'ALL',
  target_kind: '', target_key: '', priority: '100', waiver_allowed: false,
  policyMode: 'type', policyText: '', policySourceUrl: '',
  contributions: '{\n  "requiredEvidence": []\n}',
}

type Contrib = Record<string, unknown>

// Pull the primary `policy` promptLayer out of contributions for structured
// editing; the remaining keys (+ any other promptLayers) go to advanced JSON.
function splitContributions(contrib: Contrib): {
  policyMode: 'type' | 'link'; policyText: string; policySourceUrl: string; rest: Contrib
} {
  const layers = Array.isArray(contrib.promptLayers) ? contrib.promptLayers as Contrib[] : []
  const policy = layers.find(l => l?.layerKey === 'policy') ?? layers[0]
  const others = layers.filter(l => l !== policy)
  const rest: Contrib = { ...contrib }
  if (others.length) rest.promptLayers = others
  else delete rest.promptLayers
  return {
    policyMode: policy?.sourceUrl ? 'link' : 'type',
    policyText: typeof policy?.text === 'string' ? policy.text : '',
    policySourceUrl: typeof policy?.sourceUrl === 'string' ? policy.sourceUrl : '',
    rest,
  }
}

// Build the `policy` promptLayer from the link-or-type fields (null when empty).
function buildPolicyLayer(f: FormState): Contrib | null {
  if (f.policyMode === 'link') {
    const url = f.policySourceUrl.trim()
    return url ? { layerKey: 'policy', order: 10, title: 'Policy', sourceUrl: url } : null
  }
  const text = f.policyText.trim()
  return text ? { layerKey: 'policy', order: 10, title: 'Policy', text } : null
}

export function GovernanceTab({ capabilityId }: { capabilityId: string }) {
  const { data: attachments, isLoading } = useGovernedBy(capabilityId, true)
  const { data: governingPage } = useGoverningCapabilities()
  const attach = useAttachGovernance(capabilityId)
  const update = useUpdateGovernance(capabilityId)
  const deactivate = useDeactivateGovernance(capabilityId)
  const reactivate = useReactivateGovernance(capabilityId)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<GovernanceAttachment | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [showJson, setShowJson] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const governingName = useMemo(
    () => new Map((governingPage?.items ?? []).map(c => [c.capability_id, c.name])),
    [governingPage],
  )
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

  let jsonError: string | null = null
  try { if (form.contributions.trim()) JSON.parse(form.contributions) }
  catch (e) { jsonError = e instanceof Error ? e.message : 'invalid JSON' }

  function openCreate() {
    setEditing(null); setForm(EMPTY_FORM); setShowJson(false); setError(null); setOpen(true)
  }
  function openEdit(a: GovernanceAttachment) {
    setEditing(a)
    const split = splitContributions(a.contributions ?? {})
    setForm({
      governing_capability_id: a.governing_capability_id, mode: a.mode, scope: a.scope,
      target_kind: a.target_kind ?? '', target_key: a.target_key ?? '',
      priority: String(a.priority), waiver_allowed: a.waiver_allowed,
      policyMode: split.policyMode, policyText: split.policyText, policySourceUrl: split.policySourceUrl,
      contributions: JSON.stringify(split.rest, null, 2),
    })
    setShowJson(false); setError(null); setOpen(true)
  }

  async function submit() {
    setError(null)
    if (jsonError) { setError(`contributions: ${jsonError}`); return }
    const rest: Contrib = form.contributions.trim() ? JSON.parse(form.contributions) : {}
    // Merge the structured policy layer back in front of any advanced layers.
    const policyLayer = buildPolicyLayer(form)
    const existing = Array.isArray(rest.promptLayers) ? rest.promptLayers as Contrib[] : []
    const promptLayers = [...(policyLayer ? [policyLayer] : []), ...existing]
    const contributions: Contrib = { ...rest }
    if (promptLayers.length) contributions.promptLayers = promptLayers
    else delete contributions.promptLayers
    const scoped = form.scope !== 'ALL'
    const common = {
      mode: form.mode, scope: form.scope,
      target_kind: scoped ? (form.target_kind.trim() || (form.scope === 'STAGE' ? 'STAGE_KEY' : null)) : null,
      target_key: scoped ? (form.target_key.trim() || null) : null,
      priority: Number(form.priority) || 100,
      waiver_allowed: form.waiver_allowed,
      contributions,
    }
    try {
      if (editing) {
        await update.mutateAsync({ attachmentId: editing.id, body: common })
      } else {
        if (!form.governing_capability_id) { setError('select a governing policy'); return }
        await attach.mutateAsync({ governing_capability_id: form.governing_capability_id, ...common })
      }
      setOpen(false)
    } catch (e) { setError(errMessage(e)) }
  }

  const pending = attach.isPending || update.isPending
  const rows = attachments ?? []

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400">
          Policies governing this capability (<code>governed_by</code>). Authored here — not in Relationships.
        </p>
        <Button size="sm" onClick={openCreate} className="bg-[#00843D] hover:bg-[#006830]">
          <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Attach policy
        </Button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50">
        {isLoading ? (
          <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
        ) : !rows.length ? (
          <p className="text-sm text-gray-400 text-center py-8">Not governed by any policy.</p>
        ) : rows.map(a => {
          const evidence = (a.contributions?.['requiredEvidence'] as unknown[] | undefined)?.length ?? 0
          const layers = (a.contributions?.['promptLayers'] as unknown[] | undefined)?.length ?? 0
          return (
            <div key={a.id} className={`px-4 py-3 ${a.is_active ? '' : 'opacity-50'}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900">
                  {governingName.get(a.governing_capability_id) ?? a.governing_capability_id}
                </span>
                <StatusBadge label={a.mode} className={MODE_CLASS[a.mode]} />
                <span className="text-xs text-gray-400">
                  {a.scope}{a.target_key ? `:${a.target_key}` : ''} · prio {a.priority} · v{a.version}
                  {!a.is_active && ' · inactive'}
                </span>
                <div className="ml-auto flex gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => openEdit(a)}>Edit</Button>
                  {a.is_active ? (
                    <Button variant="outline" size="sm" disabled={deactivate.isPending}
                      onClick={() => deactivate.mutate(a.id)}>Deactivate</Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={reactivate.isPending}
                      onClick={() => reactivate.mutate(a.id)}>Reactivate</Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {evidence} required-evidence · {layers} prompt layer(s)
                {a.waiver_allowed ? ' · waivers allowed' : ''}
              </p>
            </div>
          )
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit governance attachment' : 'Attach governing policy'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {!editing && (
              <div className="space-y-1.5">
                <Label>Governing policy</Label>
                <Select value={form.governing_capability_id}
                  onValueChange={v => set('governing_capability_id', v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Select a governing capability…" /></SelectTrigger>
                  <SelectContent>
                    {(governingPage?.items ?? []).map(c => (
                      <SelectItem key={c.capability_id} value={c.capability_id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Mode</Label>
                <Select value={form.mode} onValueChange={v => set('mode', v as GovernanceMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GOVERNANCE_MODES.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Scope</Label>
                <Select value={form.scope} onValueChange={v => set('scope', v as GovernanceScope)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GOVERNANCE_SCOPES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.scope !== 'ALL' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Target kind</Label>
                  <Input placeholder={form.scope === 'STAGE' ? 'STAGE_KEY' : 'WORKFLOW_ID'}
                    value={form.target_kind} onChange={e => set('target_kind', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Target key</Label>
                  <Input placeholder={form.scope === 'STAGE' ? 'DEVELOP' : ''}
                    value={form.target_key} onChange={e => set('target_key', e.target.value)} />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 items-end">
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Input type="number" value={form.priority} onChange={e => set('priority', e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
                <input type="checkbox" checked={form.waiver_allowed}
                  onChange={e => set('waiver_allowed', e.target.checked)} />
                Waivers allowed
              </label>
            </div>

            {form.mode !== 'ADVISORY' && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                {form.mode} is <strong>enforcing</strong> — it can halt live runs and requires elevated
                authority (super-admin or <code>governance:enforce</code>).
              </p>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Policy content</Label>
                <div className="flex gap-1 text-xs">
                  <button type="button"
                    className={`px-2 py-0.5 rounded ${form.policyMode === 'type' ? 'bg-[#00843D] text-white' : 'border border-gray-300 text-gray-600'}`}
                    onClick={() => set('policyMode', 'type')}>Type inline</button>
                  <button type="button"
                    className={`px-2 py-0.5 rounded ${form.policyMode === 'link' ? 'bg-[#00843D] text-white' : 'border border-gray-300 text-gray-600'}`}
                    onClick={() => set('policyMode', 'link')}>Link to doc</button>
                </div>
              </div>
              {form.policyMode === 'link' ? (
                <>
                  <Input placeholder="https://…/policy.md"
                    value={form.policySourceUrl} onChange={e => set('policySourceUrl', e.target.value)} />
                  <p className="text-xs text-gray-400">
                    Markdown doc, <strong>fetched live</strong> at resolve time (SSRF-guarded) — the agent
                    sees the current doc each run.
                  </p>
                </>
              ) : (
                <>
                  <textarea
                    className="w-full h-32 text-sm rounded-md border border-gray-300 p-2"
                    placeholder="Write the policy guidance the agent should follow (markdown)…"
                    value={form.policyText} onChange={e => set('policyText', e.target.value)} />
                  <p className="text-xs text-gray-400">Injected verbatim as a prompt layer.</p>
                </>
              )}
            </div>

            <div>
              <button type="button" className="text-xs text-gray-500 underline"
                onClick={() => setShowJson(s => !s)}>
                {showJson ? 'Hide' : 'Edit'} contributions JSON (advanced)
              </button>
              {showJson && (
                <div className="space-y-1.5 mt-2">
                  <textarea
                    className="w-full h-44 font-mono text-xs rounded-md border border-gray-300 p-2"
                    value={form.contributions} onChange={e => set('contributions', e.target.value)} />
                  {jsonError && <p className="text-xs text-red-600">JSON: {jsonError}</p>}
                  <p className="text-xs text-gray-400">
                    keys: requiredEvidence · verifierAgents · approvalGates · waiverRules ·
                    blockingControls · toolPolicy (the primary policy text is set above)
                  </p>
                </div>
              )}
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={submit} disabled={pending || !!jsonError}
                className="bg-[#00843D] hover:bg-[#006830]">
                {pending ? 'Saving…' : editing ? 'Save' : 'Attach'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
