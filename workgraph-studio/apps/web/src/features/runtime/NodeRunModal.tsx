/**
 * NodeRunModal — centered overlay shown when a user clicks an ACTIVE node on
 * the run player canvas. Body adapts to nodeType:
 *
 *   HUMAN_TASK / CONSUMABLE_CREATION → widget form + Save draft + Complete
 *   APPROVAL                         → widget form + decision (Approve / Reject) + comments
 *   DECISION_GATE                    → read-only branch preview against current context
 *
 * Header actions (HUMAN_TASK / APPROVAL / CONSUMABLE_CREATION):
 *   Delegate  — forward the task to another user; transfers claimedBy
 *   Sub-tasks — ad-hoc checklist items attached to this node at runtime
 */

import { useEffect, useRef, useState } from 'react'
import {
  X, CheckCircle2, XCircle, GitBranch,
  Paperclip, Upload, Link2, ExternalLink, FileText, AlertCircle,
  UserCheck, ListTodo, Check, Trash2, User, Route,
} from 'lucide-react'
import type {
  BrowserWorkflowRuntime,
  RunNodeState,
  EngineNodeDef,
  BranchPreview,
  SubTask,
} from '@workgraph/engine'
import { RuntimeWidgetForm } from '../forms/widgets/RuntimeWidgetForm'
import type { FormWidget } from '../forms/widgets/types'
import { uploadAttachment, attachLink, type UploadedDocument } from '../../lib/uploadAttachment'
import { api } from '../../lib/api'

interface Props {
  runtime: BrowserWorkflowRuntime
  node: EngineNodeDef
  nodeState: RunNodeState
  actorEmail?: string
  onClose: () => void
}

type Panel = 'none' | 'delegate' | 'subtasks'

export function NodeRunModal({ runtime, node, nodeState, actorEmail, onClose }: Props) {
  const config = (node.config ?? {}) as Record<string, unknown>
  const widgets = (config.formWidgets as FormWidget[] | undefined) ?? []

  const isApproval   = node.nodeType === 'APPROVAL'
  const isDecision   = node.nodeType === 'DECISION_GATE'
  const workbenchConfig = isPlainRecord(config.workbench) ? config.workbench : undefined
  const isWorkbenchTask = node.nodeType === 'WORKBENCH_TASK'
  const isInteractive = !isDecision

  const [panel, setPanel] = useState<Panel>('none')

  const togglePanel = (p: Panel) => setPanel(cur => cur === p ? 'none' : p)

  const subTasks = nodeState.subTasks ?? []
  const openSubTasks = subTasks.filter(t => !t.done).length

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.55)', backdropFilter: 'blur(2px)',
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: isWorkbenchTask ? 'min(1280px, 96vw)' : 660,
          maxWidth: '96vw',
          maxHeight: '92vh',
          background: 'var(--color-surface)',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          border: '1px solid var(--color-outline-variant)',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--color-outline-variant)',
          gap: 10,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.16em', color: 'var(--color-outline)',
            }}>
              {isWorkbenchTask ? 'WORKBENCH TASK' : node.nodeType.replaceAll('_', ' ')}
            </p>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.label || node.id}
            </h3>
          </div>

          {/* Action buttons — only for interactive nodes */}
          {isInteractive && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {/* Delegate */}
              <button
                onClick={() => togglePanel('delegate')}
                title="Delegate to another user"
                style={headerBtn(panel === 'delegate', '#6366f1')}
              >
                <UserCheck size={14} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>Delegate</span>
              </button>

              {/* Sub-tasks */}
              <button
                onClick={() => togglePanel('subtasks')}
                title="Add / view sub-tasks"
                style={headerBtn(panel === 'subtasks', '#0ea5e9')}
              >
                <ListTodo size={14} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>Tasks</span>
                {openSubTasks > 0 && (
                  <span style={{
                    minWidth: 16, height: 16, borderRadius: 8, fontSize: 10, fontWeight: 700,
                    background: '#ef4444', color: '#fff',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '0 4px',
                  }}>
                    {openSubTasks}
                  </span>
                )}
              </button>
            </div>
          )}

          <button
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 10, border: '1px solid var(--color-outline-variant)',
              background: 'transparent', cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--color-outline)',
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Inline panels (Delegate / Sub-tasks) ── */}
        {panel === 'delegate' && (
          <DelegatePanel
            runtime={runtime}
            nodeId={node.id}
            nodeState={nodeState}
            actorEmail={actorEmail}
            onDone={() => setPanel('none')}
          />
        )}

        {panel === 'subtasks' && (
          <SubTaskPanel
            runtime={runtime}
            nodeId={node.id}
            subTasks={subTasks}
          />
        )}

        {/* ── Body ── */}
        <div style={{ padding: 18, overflow: 'auto', flex: 1 }}>
          {!nodeState.claimedBy && !isDecision && (
            <ClaimBar
              onClaim={() => runtime.claim(node.id, actorEmail ?? 'anonymous')}
            />
          )}
          {nodeState.claimedBy && !isDecision && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
              <User size={11} style={{ color: 'var(--color-outline)' }} />
              <p style={{ fontSize: 11, color: 'var(--color-outline)', margin: 0 }}>
                Claimed by <strong>{nodeState.claimedBy}</strong>
              </p>
              {(nodeState.delegations?.length ?? 0) > 0 && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  padding: '1px 6px', borderRadius: 4,
                  background: 'rgba(99,102,241,0.12)', color: '#6366f1',
                }}>
                  delegated {nodeState.delegations!.length}×
                </span>
              )}
            </div>
          )}

          {/* Universal attachments */}
          {!isDecision && (
            <UniversalAttachments
              runtime={runtime}
              nodeId={node.id}
              nodeState={nodeState}
              disabled={!nodeState.claimedBy}
            />
          )}

          {isWorkbenchTask ? (
            <BlueprintWorkbenchBody
              runtime={runtime}
              node={node}
              config={workbenchConfig}
              actorEmail={actorEmail}
              claimed={!!nodeState.claimedBy}
              onComplete={(output) => {
                runtime.complete(node.id, output, actorEmail)
                onClose()
              }}
            />
          ) : isDecision ? (
            <DecisionPreview previews={runtime.previewBranches(node.id)} />
          ) : isApproval ? (
            <ApprovalBody
              widgets={widgets}
              initialData={nodeState.formData}
              onApprove={(form, attachments, comments) => {
                runtime.decide(node.id, 'APPROVED', { form, attachments, comments }, actorEmail)
                onClose()
              }}
              onReject={(form, attachments, comments) => {
                runtime.decide(node.id, 'REJECTED', { form, attachments, comments }, actorEmail)
                onClose()
              }}
              actorEmail={actorEmail}
              nodeId={node.id}
              claimed={!!nodeState.claimedBy}
            />
          ) : (
            <FormBody
              widgets={widgets}
              initialData={nodeState.formData}
              onSaveDraft={(form, attachments) => {
                runtime.saveDraft(node.id, form, attachments)
              }}
              onComplete={(form, attachments) => {
                runtime.complete(node.id, { form, attachments }, actorEmail)
                onClose()
              }}
              nodeId={node.id}
              claimed={!!nodeState.claimedBy}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function BlueprintWorkbenchBody({
  runtime,
  node,
  config,
  actorEmail,
  claimed,
  onComplete,
}: {
  runtime: BrowserWorkflowRuntime
  node: EngineNodeDef
  config?: Record<string, unknown>
  actorEmail?: string
  claimed: boolean
  onComplete: (output: Record<string, unknown>) => void
}) {
  const [sessionId, setSessionId] = useState('')
  const [finalizedPack, setFinalizedPack] = useState<Record<string, unknown> | null>(null)
  const completedRef = useRef(false)
  const runState = runtime.getState()
  const nodeConfig = (node.config ?? {}) as Record<string, unknown>
  const workbenchConfig = isPlainRecord(config)
    ? config
    : isPlainRecord(nodeConfig.workbench) ? nodeConfig.workbench : {}
  const workbenchUrl = buildWorkbenchUrl(runState.runId, node.id, workbenchConfig)
  const outputs = isPlainRecord(workbenchConfig.outputs) ? workbenchConfig.outputs : {}
  const finalPackKey = typeof outputs.finalPackKey === 'string' && outputs.finalPackKey.trim()
    ? outputs.finalPackKey.trim()
    : 'finalImplementationPack'

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== 'http://localhost:5176') return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'blueprintWorkbench.finalized') return
      if (data.workflowInstanceId && data.workflowInstanceId !== runState.runId) return
      if (data.workflowNodeId && data.workflowNodeId !== node.id) return
      const nextSessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const nextFinalPack = data.finalPack && typeof data.finalPack === 'object' ? data.finalPack as Record<string, unknown> : null
      if (nextSessionId) setSessionId(nextSessionId)
      if (nextFinalPack) setFinalizedPack(nextFinalPack)
      if (nextSessionId && !completedRef.current) {
        completedRef.current = true
        onComplete({
          blueprintSessionId: nextSessionId,
          workbenchStatus: typeof data.status === 'string' ? data.status : 'FINALIZED',
          [finalPackKey]: nextFinalPack ?? undefined,
          workbench: {
            profile: typeof workbenchConfig.profile === 'string' ? workbenchConfig.profile : 'blueprint',
            sessionId: nextSessionId,
            workbenchUrl,
            workflowInstanceId: runState.runId,
            workflowNodeId: node.id,
            completedBy: actorEmail,
            completedAt: new Date().toISOString(),
          },
        })
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [actorEmail, finalPackKey, node.id, onComplete, runState.runId, workbenchConfig.profile, workbenchUrl])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: claimed ? 1 : 0.55, pointerEvents: claimed ? 'auto' : 'none' }}>
      <div style={{
        border: '1px solid rgba(0,75,141,0.22)',
        borderRadius: 12,
        padding: 12,
        background: 'rgba(0,75,141,0.06)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Route size={15} style={{ color: '#004b8d' }} />
          <strong style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>Workbench Task loop</strong>
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--color-outline)' }}>
          This workflow node opens the Blueprint Workbench. The session is linked to this workflow run and node; finalization returns the approved implementation pack as this node output.
        </p>
      </div>

      <iframe
        title="Blueprint Workbench"
        src={workbenchUrl}
        style={{
          width: '100%',
          height: 680,
          border: '1px solid var(--color-outline-variant)',
          borderRadius: 12,
          background: '#0b1326',
        }}
      />

      <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
        Blueprint session / final pack reference
      </label>
      <input
        value={sessionId}
        onChange={event => setSessionId(event.target.value)}
        placeholder="Paste finalized Blueprint session id or final pack id"
        style={inputStyle()}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <a href={workbenchUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#004b8d', fontWeight: 700 }}>
          Open full workbench
        </a>
        <button
          disabled={!sessionId.trim()}
          onClick={() => onComplete({
            blueprintSessionId: sessionId.trim(),
            workbenchStatus: finalizedPack ? 'FINALIZED' : 'MANUAL_REFERENCE',
            [finalPackKey]: finalizedPack ?? undefined,
            workbench: {
              profile: typeof workbenchConfig.profile === 'string' ? workbenchConfig.profile : 'blueprint',
              sessionId: sessionId.trim(),
              workbenchUrl,
              workflowInstanceId: runState.runId,
              workflowNodeId: node.id,
              completedBy: actorEmail,
              completedAt: new Date().toISOString(),
            },
          })}
          style={btnPrimary(!sessionId.trim())}
        >
          <CheckCircle2 size={14} /> Complete with final pack
        </button>
      </div>

      {!claimed && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', textAlign: 'right' }}>
          Claim this node to use the embedded workbench.
        </p>
      )}
    </div>
  )
}

function buildWorkbenchUrl(workflowInstanceId: string, workflowNodeId: string, config?: Record<string, unknown>) {
  const url = new URL('http://localhost:5176/')
  const bindings = config?.agentBindings && typeof config.agentBindings === 'object' && !Array.isArray(config.agentBindings)
    ? config.agentBindings as Record<string, unknown>
    : {}
  url.searchParams.set('workflowInstanceId', workflowInstanceId)
  url.searchParams.set('workflowNodeId', workflowNodeId)
  if (typeof config?.phaseId === 'string') url.searchParams.set('phaseId', config.phaseId)
  if (typeof config?.goal === 'string') url.searchParams.set('goal', config.goal)
  else if (typeof config?.task === 'string') url.searchParams.set('goal', config.task)
  if (config?.sourceType === 'github' || config?.sourceType === 'localdir') url.searchParams.set('sourceType', config.sourceType)
  if (typeof config?.sourceUri === 'string') url.searchParams.set('sourceUri', config.sourceUri)
  if (typeof config?.sourceRef === 'string') url.searchParams.set('sourceRef', config.sourceRef)
  if (typeof config?.capabilityId === 'string') url.searchParams.set('capabilityId', config.capabilityId)
  if (typeof bindings.architectAgentTemplateId === 'string') url.searchParams.set('architectAgentTemplateId', bindings.architectAgentTemplateId)
  if (typeof bindings.developerAgentTemplateId === 'string') url.searchParams.set('developerAgentTemplateId', bindings.developerAgentTemplateId)
  if (typeof bindings.qaAgentTemplateId === 'string') url.searchParams.set('qaAgentTemplateId', bindings.qaAgentTemplateId)
  if (config?.gateMode === 'auto' || config?.gateMode === 'manual') url.searchParams.set('gateMode', config.gateMode)
  if (config?.loopDefinition && typeof window !== 'undefined') {
    try {
      url.searchParams.set('loopDefinition', window.btoa(JSON.stringify(config.loopDefinition)))
    } catch {
      // Keep the modal usable even when a non-serializable config sneaks in.
    }
  }
  return url.toString()
}

// ─── Delegate panel ──────────────────────────────────────────────────────────

function DelegatePanel({
  runtime, nodeId, nodeState, actorEmail, onDone,
}: {
  runtime: BrowserWorkflowRuntime
  nodeId: string
  nodeState: RunNodeState
  actorEmail?: string
  onDone: () => void
}) {
  const [users, setUsers]     = useState<Array<{ id: string; email: string; displayName?: string }>>([])
  const [query, setQuery]     = useState('')
  const [toUser, setToUser]   = useState('')
  const [note, setNote]       = useState('')
  const [loading, setLoading] = useState(false)

  // Fetch user list once
  useEffect(() => {
    api.get('/users?size=200').then(r => setUsers(r.data?.content ?? [])).catch(() => {})
  }, [])

  const filtered = users.filter(u => {
    const q = query.toLowerCase()
    return !q || u.email.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)
  })

  const canSend = toUser.trim().length > 0

  const forward = () => {
    if (!canSend) return
    setLoading(true)
    runtime.delegate(nodeId, toUser.trim(), note.trim() || undefined, actorEmail)
    setLoading(false)
    onDone()
  }

  return (
    <div style={{
      borderBottom: '1px solid var(--color-outline-variant)',
      background: 'rgba(99,102,241,0.04)',
      padding: '12px 18px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <p style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', margin: 0 }}>
        Forward this task to another user
      </p>

      {/* Current owner */}
      {nodeState.claimedBy && (
        <p style={{ fontSize: 11, color: 'var(--color-outline)', margin: 0 }}>
          Currently with: <strong>{nodeState.claimedBy}</strong>
        </p>
      )}

      {/* User search */}
      <input
        type="text"
        placeholder="Search users by name or email…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={inputStyle()}
      />

      {/* User list */}
      {filtered.length > 0 && (
        <div style={{
          maxHeight: 140, overflowY: 'auto', borderRadius: 8,
          border: '1px solid var(--color-outline-variant)', background: '#fff',
        }}>
          {filtered.slice(0, 20).map(u => (
            <button
              key={u.id}
              onClick={() => { setToUser(u.email); setQuery(u.displayName ?? u.email) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '7px 10px', border: 'none',
                cursor: 'pointer', textAlign: 'left',
                borderBottom: '1px solid var(--color-outline-variant)',
                background: toUser === u.email ? 'rgba(99,102,241,0.1)' : 'transparent',
              }}
            >
              <div style={{
                width: 26, height: 26, borderRadius: '50%',
                background: 'rgba(99,102,241,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, color: '#6366f1', flexShrink: 0,
              }}>
                {(u.displayName ?? u.email).charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)' }}>
                  {u.displayName ?? u.email}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>{u.email}</div>
              </div>
              {toUser === u.email && <Check size={12} style={{ color: '#6366f1', marginLeft: 'auto' }} />}
            </button>
          ))}
        </div>
      )}

      {/* Or type freeform */}
      {!users.length && (
        <input
          type="email"
          placeholder="Enter email / name directly"
          value={toUser}
          onChange={e => setToUser(e.target.value)}
          style={inputStyle()}
        />
      )}

      {/* Note */}
      <textarea
        rows={2}
        placeholder="Add a note (optional)…"
        value={note}
        onChange={e => setNote(e.target.value)}
        style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
      />

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={onDone} style={btnGhost()}>Cancel</button>
        <button
          onClick={forward}
          disabled={!canSend || loading}
          style={{
            ...btnPrimary(!canSend || loading),
            background: '#6366f1',
          }}
        >
          <UserCheck size={13} /> Forward task
        </button>
      </div>

      {/* Delegation history */}
      {(nodeState.delegations?.length ?? 0) > 0 && (
        <div style={{ marginTop: 4 }}>
          <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-outline)', marginBottom: 4 }}>
            History
          </p>
          {nodeState.delegations!.map((d, i) => (
            <div key={i} style={{ fontSize: 10, color: 'var(--color-outline)', padding: '2px 0' }}>
              {new Date(d.at).toLocaleString()} — <strong>{d.from}</strong> → <strong>{d.to}</strong>
              {d.note && <span style={{ fontStyle: 'italic' }}> "{d.note}"</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sub-task panel ─────────────────────────────────────────────────────────

function SubTaskPanel({
  runtime, nodeId, subTasks,
}: {
  runtime: BrowserWorkflowRuntime
  nodeId: string
  subTasks: SubTask[]
}) {
  const [title,    setTitle]    = useState('')
  const [assignee, setAssignee] = useState('')
  const [notes,    setNotes]    = useState('')
  const [adding,   setAdding]   = useState(false)
  const [users, setUsers]       = useState<Array<{ id: string; email: string; displayName?: string }>>([])

  useEffect(() => {
    api.get('/users?size=200').then(r => setUsers(r.data?.content ?? [])).catch(() => {})
  }, [])

  const submit = () => {
    if (!title.trim()) return
    runtime.addSubTask(nodeId, { title: title.trim(), assignee: assignee.trim() || undefined, notes: notes.trim() || undefined })
    setTitle(''); setAssignee(''); setNotes(''); setAdding(false)
  }

  const done  = subTasks.filter(t => t.done).length
  const total = subTasks.length

  return (
    <div style={{
      borderBottom: '1px solid var(--color-outline-variant)',
      background: 'rgba(14,165,233,0.04)',
      padding: '12px 18px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: '#0ea5e9', margin: 0, flex: 1 }}>
          Sub-tasks
        </p>
        {total > 0 && (
          <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
            {done}/{total} done
          </span>
        )}
        <button
          onClick={() => setAdding(v => !v)}
          style={{
            ...headerBtn(adding, '#0ea5e9'),
            padding: '4px 10px',
          }}
        >
          {adding ? 'Cancel' : '+ Add task'}
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <div style={{
          padding: 10, borderRadius: 8,
          border: '1px solid rgba(14,165,233,0.25)', background: 'rgba(14,165,233,0.05)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <input
            autoFocus
            placeholder="Task title *"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            style={inputStyle()}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              style={{ ...inputStyle(), flex: 1 }}
            >
              <option value="">Assign to… (optional)</option>
              {users.map(u => (
                <option key={u.id} value={u.email}>
                  {u.displayName ?? u.email}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={2}
            placeholder="Notes (optional)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setAdding(false)} style={btnGhost()}>Cancel</button>
            <button
              onClick={submit}
              disabled={!title.trim()}
              style={{ ...btnPrimary(!title.trim()), background: '#0ea5e9' }}
            >
              Add task
            </button>
          </div>
        </div>
      )}

      {/* Task list */}
      {subTasks.length === 0 && !adding && (
        <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', textAlign: 'center', padding: '6px 0' }}>
          No sub-tasks yet — add one to track additional work.
        </p>
      )}

      {subTasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {subTasks.map(t => (
            <div
              key={t.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '7px 10px', borderRadius: 8, background: '#fff',
                border: `1px solid ${t.done ? 'rgba(34,197,94,0.25)' : 'var(--color-outline-variant)'}`,
                opacity: t.done ? 0.7 : 1,
              }}
            >
              {/* Checkbox */}
              <button
                onClick={() => runtime.toggleSubTask(nodeId, t.id)}
                style={{
                  width: 18, height: 18, borderRadius: 4, flexShrink: 0, marginTop: 1,
                  border: t.done ? 'none' : '2px solid var(--color-outline-variant)',
                  background: t.done ? '#22c55e' : 'transparent',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {t.done && <Check size={11} color="#fff" />}
              </button>

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{
                  fontSize: 12, fontWeight: 600, margin: 0,
                  color: 'var(--color-on-surface)',
                  textDecoration: t.done ? 'line-through' : 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {t.title}
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                  {t.assignee && (
                    <span style={{ fontSize: 10, color: '#6366f1', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <User size={9} /> {t.assignee}
                    </span>
                  )}
                  {t.notes && (
                    <span style={{ fontSize: 10, color: 'var(--color-outline)', fontStyle: 'italic' }}>
                      {t.notes}
                    </span>
                  )}
                  {t.doneAt && (
                    <span style={{ fontSize: 10, color: '#22c55e' }}>
                      Done {new Date(t.doneAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>

              <button
                onClick={() => runtime.removeSubTask(nodeId, t.id)}
                title="Remove"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#94a3b8', padding: 2, flexShrink: 0,
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sub-bodies ─────────────────────────────────────────────────────────────

function ClaimBar({ onClaim }: { onClaim: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 12px', marginBottom: 14,
      borderRadius: 10, border: '1px dashed var(--color-outline-variant)',
      background: 'rgba(0,132,61,0.05)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>
        This node is unclaimed.
      </span>
      <button
        onClick={onClaim}
        style={{
          padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'var(--color-primary)', color: '#fff',
          fontSize: 12, fontWeight: 600,
        }}
      >
        Claim
      </button>
    </div>
  )
}

function FormBody({
  widgets, initialData, onSaveDraft, onComplete, nodeId, claimed,
}: {
  widgets: FormWidget[]
  initialData?: Record<string, unknown>
  onSaveDraft: (form: Record<string, unknown>, attachmentIds: string[]) => void
  onComplete: (form: Record<string, unknown>, attachmentIds: string[]) => void
  nodeId: string
  claimed: boolean
}) {
  return (
    <div style={{ opacity: claimed ? 1 : 0.55, pointerEvents: claimed ? 'auto' : 'none' }}>
      <RuntimeWidgetForm
        widgets={widgets}
        submitTo={{ kind: 'task', id: nodeId }}
        link={{ nodeId }}
        initialData={initialData ?? {}}
        primaryLabel="Complete & advance"
        submitOverride={async ({ data, attachmentIds, complete }) => {
          if (complete) onComplete(data, attachmentIds)
          else          onSaveDraft(data, attachmentIds)
        }}
      />
      {!claimed && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', textAlign: 'right', marginTop: 8 }}>
          Claim this node to enable form fill &amp; complete.
        </p>
      )}
    </div>
  )
}

function ApprovalBody({
  widgets, initialData, onApprove, onReject, actorEmail, nodeId, claimed,
}: {
  widgets: FormWidget[]
  initialData?: Record<string, unknown>
  onApprove: (form: Record<string, unknown>, attachments: string[], comments?: string) => void
  onReject:  (form: Record<string, unknown>, attachments: string[], comments?: string) => void
  actorEmail?: string
  nodeId: string
  claimed: boolean
}) {
  const [comments, setComments] = useState('')
  const [form, setForm] = useState<{ data: Record<string, unknown>; attachmentIds: string[] }>({
    data: initialData ?? {}, attachmentIds: [],
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: claimed ? 1 : 0.55, pointerEvents: claimed ? 'auto' : 'none' }}>
      {widgets.length > 0 && (
        <RuntimeWidgetForm
          widgets={widgets}
          submitTo={{ kind: 'approval', id: nodeId }}
          link={{ nodeId }}
          initialData={initialData ?? {}}
          hideActions
          onValuesChange={setForm}
          submitOverride={async () => {}}
        />
      )}

      <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
        Comments
      </label>
      <textarea
        rows={3}
        value={comments}
        onChange={e => setComments(e.target.value)}
        placeholder="Optional comments…"
        style={{
          padding: 10, borderRadius: 8,
          border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface)',
          fontSize: 12, color: 'var(--color-on-surface)', resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => onReject(form.data, form.attachmentIds, comments)}
          style={{
            padding: '8px 14px', borderRadius: 8, border: '1px solid #fecaca',
            background: '#fee2e2', color: '#b91c1c', fontWeight: 600, fontSize: 12,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <XCircle size={14} /> Reject
        </button>
        <button
          onClick={() => onApprove(form.data, form.attachmentIds, comments)}
          style={{
            padding: '8px 14px', borderRadius: 8, border: 'none',
            background: 'var(--color-primary)', color: '#fff',
            fontWeight: 600, fontSize: 12,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <CheckCircle2 size={14} /> Approve &amp; advance
        </button>
      </div>

      {!claimed && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', textAlign: 'right' }}>
          Claim this node to enable approval actions.
        </p>
      )}
      {claimed && actorEmail && (
        <p style={{ fontSize: 10, color: 'var(--color-outline)', textAlign: 'right' }}>
          Acting as <strong>{actorEmail}</strong>
        </p>
      )}
    </div>
  )
}

function DecisionPreview({ previews }: { previews: BranchPreview[] }) {
  if (previews.length === 0) {
    return (
      <p style={{ fontSize: 12, color: 'var(--color-outline)', fontStyle: 'italic' }}>
        This decision gate has no outgoing branches.
      </p>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 11, color: 'var(--color-outline)' }}>
        Branch preview against current context:
      </p>
      {previews.map(p => {
        const cond = (p.edge.condition ?? {}) as Record<string, unknown>
        const label = (cond.label as string | undefined) ?? p.edge.id
        const bg = p.willFire ? 'rgba(34,197,94,0.12)'
                 : p.matched  ? 'rgba(245,158,11,0.10)'
                 : 'transparent'
        const border = p.willFire ? '1px solid rgba(34,197,94,0.4)'
                     : p.matched  ? '1px solid rgba(245,158,11,0.3)'
                     : '1px solid var(--color-outline-variant)'
        return (
          <div
            key={p.edge.id}
            style={{
              padding: '10px 12px', borderRadius: 10, border, background: bg,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GitBranch size={14} style={{ color: p.willFire ? '#16a34a' : 'var(--color-outline)' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)' }}>
                {label}
              </span>
              {p.isDefault && (
                <span style={{
                  fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em',
                  padding: '2px 6px', borderRadius: 4,
                  background: 'rgba(100,116,139,0.16)', color: 'var(--color-outline)',
                }}>
                  default
                </span>
              )}
            </div>
            <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
              {p.willFire ? 'Will fire' : p.matched ? 'Also matches' : 'No match'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Universal attachments (any node, any kind) ─────────────────────────────

function UniversalAttachments({
  runtime, nodeId, nodeState, disabled,
}: {
  runtime: BrowserWorkflowRuntime
  nodeId:  string
  nodeState: RunNodeState
  disabled: boolean
}) {
  const ids: string[] = nodeState.attachmentIds ?? []
  const [docs, setDocs] = useState<UploadedDocument[]>([])
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)

  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl,  setLinkUrl]  = useState('')
  const [linkName, setLinkName] = useState('')

  useEffect(() => {
    let cancelled = false
    const known = new Set(docs.map(d => d.id))
    const missing = ids.filter(id => !known.has(id))
    if (missing.length === 0) return
    Promise.all(missing.map(async id => {
      try { const { data } = await api.get(`/documents/${id}`); return data as UploadedDocument } catch { return null }
    })).then(rows => {
      if (cancelled) return
      const valid = rows.filter(Boolean) as UploadedDocument[]
      setDocs(prev => [...prev, ...valid.filter(v => !prev.find(p => p.id === v.id))])
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|')])

  const persist = (nextDocs: UploadedDocument[]) => {
    const nextIds = nextDocs.map(d => d.id)
    runtime.saveDraft(nodeId, nodeState.formData ?? {}, nextIds)
  }

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setBusy(true); setErr(null)
    try {
      const uploaded: UploadedDocument[] = []
      for (const f of files) {
        const doc = await uploadAttachment(f, { nodeId })
        uploaded.push(doc)
      }
      const next = [...docs, ...uploaded]
      setDocs(next)
      persist(next)
    } catch (ex: any) {
      setErr(ex?.response?.data?.error ?? ex?.message ?? 'Upload failed')
    } finally {
      setBusy(false); e.target.value = ''
    }
  }

  const submitLink = async () => {
    if (!linkUrl.trim()) return
    setBusy(true); setErr(null)
    try {
      const doc = await attachLink(linkUrl.trim(), { name: linkName.trim() || undefined, nodeId })
      const next = [...docs, doc]
      setDocs(next)
      persist(next)
      setLinkUrl(''); setLinkName(''); setLinkOpen(false)
    } catch (ex: any) {
      setErr(ex?.response?.data?.error ?? ex?.message ?? 'Failed to attach link')
    } finally {
      setBusy(false)
    }
  }

  const removeOne = (id: string) => {
    const next = docs.filter(d => d.id !== id)
    setDocs(next)
    persist(next)
    api.delete(`/documents/${id}`).catch(() => { /* best effort */ })
  }

  return (
    <div style={{
      marginBottom: 14, padding: '10px 12px', borderRadius: 10,
      border: '1px solid var(--color-outline-variant)', background: 'rgba(0,0,0,0.02)',
      opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <Paperclip size={12} style={{ color: 'var(--color-outline)' }} />
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-outline)' }}>
          Attachments
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
          Files or links — OneDrive, SharePoint, Drive, anything
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <label style={{
          flex: 1,
          display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px',
          borderRadius: 8, border: '1px dashed var(--color-outline-variant)',
          background: '#fff', cursor: 'pointer', fontSize: 11, color: 'var(--color-outline)',
        }}>
          <Upload size={12} />
          <span>{busy ? 'Working…' : 'Upload file(s)'}</span>
          <input type="file" multiple onChange={onPick} style={{ display: 'none' }} />
        </label>
        <button
          type="button"
          onClick={() => setLinkOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 11px', borderRadius: 8, border: '1px dashed var(--color-outline-variant)',
            background: linkOpen ? 'rgba(56,189,248,0.08)' : '#fff', cursor: 'pointer',
            fontSize: 11, color: linkOpen ? '#0284c7' : 'var(--color-outline)',
          }}
        >
          <Link2 size={12} /> Add link
        </button>
      </div>

      {linkOpen && (
        <div style={{
          marginTop: 6, padding: 8, borderRadius: 8,
          border: '1px solid rgba(56,189,248,0.20)', background: 'rgba(56,189,248,0.04)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <input
            type="url"
            placeholder="https://… (any URL)"
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            style={inputStyle()}
          />
          <input
            placeholder="Display name (optional)"
            value={linkName}
            onChange={e => setLinkName(e.target.value)}
            style={inputStyle()}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setLinkOpen(false); setLinkUrl(''); setLinkName('') }} style={btnGhost()}>Cancel</button>
            <button onClick={submitLink} disabled={busy || !linkUrl.trim()} style={btnPrimary(busy || !linkUrl.trim())}>
              {busy ? 'Attaching…' : 'Attach link'}
            </button>
          </div>
        </div>
      )}

      {err && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#b91c1c' }}>
          <AlertCircle size={11} /> {err}
        </div>
      )}

      {docs.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {docs.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 7, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
              {d.kind === 'LINK' ? <ExternalLink size={12} style={{ color: '#0ea5e9' }} /> : <FileText size={12} style={{ color: 'var(--color-outline)' }} />}
              <a href={d.downloadUrl} target="_blank" rel="noreferrer" style={{ flex: 1, fontSize: 11, color: 'var(--color-on-surface)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.name}
              </a>
              {d.kind === 'LINK' && d.provider && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#0ea5e9', background: 'rgba(14,165,233,0.10)', padding: '2px 5px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {d.provider}
                </span>
              )}
              {d.kind !== 'LINK' && typeof d.sizeBytes === 'number' && (
                <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                  {formatBytes(d.sizeBytes)}
                </span>
              )}
              <button onClick={() => removeOne(d.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function inputStyle(): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 11,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
    background: 'var(--color-surface)',
  }
}

function headerBtn(active: boolean, color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${active ? color : 'var(--color-outline-variant)'}`,
    background: active ? `${color}18` : 'transparent',
    color: active ? color : 'var(--color-outline)',
    transition: 'all 0.15s',
  }
}

function btnGhost(): React.CSSProperties {
  return {
    padding: '5px 10px', borderRadius: 6,
    border: '1px solid var(--color-outline-variant)', background: '#fff',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  }
}

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 12px', borderRadius: 6, border: 'none',
    background: 'var(--color-primary)', color: '#fff',
    fontSize: 11, fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
  }
}
