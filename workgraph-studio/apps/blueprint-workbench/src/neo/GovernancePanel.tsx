/**
 * Capability Governance Model — read-only "Governed by" panel for the active
 * stage. Resolves the governance overlay for the session's capability + stage and
 * shows the governing entities, mode, required evidence, blocking controls, and
 * tool policy. Renders nothing when the capability isn't governed. When the
 * overlay is enforcing (BLOCKING/REQUIRED) and the stage failed, it surfaces a
 * "blocked — see controls" hint with the unblock actions.
 */
import { useQuery } from '@tanstack/react-query'
import { api, type GovernanceOverlay, type StageAttempt } from '../api'

const MODE_COLOR: Record<string, string> = {
  BLOCKING: '#f87171',
  REQUIRED: '#fbbf24',
  ADVISORY: '#7dd3fc',
}

interface Props {
  capabilityId?: string
  stageKey?: string
  agentRole?: string
  nodeId?: string
  attempt?: StageAttempt
}

export function GovernancePanel({ capabilityId, stageKey, agentRole, nodeId, attempt }: Props) {
  const query = useQuery({
    queryKey: ['governance', capabilityId, stageKey, nodeId],
    queryFn: () => api.resolveGovernance({
      capability_id: capabilityId as string,
      stage_key: stageKey,
      agent_role: agentRole,
      node_id: nodeId,
    }),
    enabled: Boolean(capabilityId),
    staleTime: 60_000,
    retry: false,
  })

  const overlay: GovernanceOverlay | undefined = query.data?.data
  const govs = overlay?.governingEntities ?? []
  if (!overlay || govs.length === 0) return null  // not governed → nothing to show

  const mode = String(overlay.effectiveMode ?? 'ADVISORY').toUpperCase()
  const modeColor = MODE_COLOR[mode] ?? MODE_COLOR.ADVISORY
  const evidence = overlay.requiredEvidence ?? []
  const blocking = overlay.blockingControls ?? []
  const tp = overlay.toolPolicy ?? {}
  const enforcing = mode === 'BLOCKING' || mode === 'REQUIRED'
  const stageBlocked = enforcing && (
    attempt?.status === 'FAILED' || attempt?.status === 'BLOCKED' || attempt?.verdict === 'BLOCKED'
  )

  return (
    <div className={`focus-governance-panel${stageBlocked ? ' blocked' : ''}`}>
      <header className="focus-governance-head">
        <strong>Governed by</strong>
        <span className="focus-governance-mode" style={{ color: modeColor, borderColor: modeColor }}>{mode}</span>
      </header>

      <ul className="focus-governance-entities">
        {govs.map(g => (
          <li key={g.capabilityId}>
            <span className="g-name">{g.name ?? g.capabilityId}</span>
            {g.mode && (
              <span className="g-emode" style={{ color: MODE_COLOR[String(g.mode).toUpperCase()] ?? undefined }}>
                {g.mode}
              </span>
            )}
          </li>
        ))}
      </ul>

      {stageBlocked && (
        <p className="focus-governance-blocked-note">
          Stage blocked — a governance control wasn’t satisfied. Submit the required evidence,
          run the verifier, or request a waiver.
        </p>
      )}

      {evidence.length > 0 && (
        <div className="focus-governance-section">
          <span className="g-label">Required evidence</span>
          <ul>
            {evidence.map((e, i) => (
              <li key={i}>{e.evidenceKey}{e.stageKey ? ` · ${e.stageKey}` : ''}{e.mode ? ` (${e.mode})` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {blocking.length > 0 && (
        <div className="focus-governance-section">
          <span className="g-label">Blocking controls</span>
          <ul>
            {blocking.map((c, i) => (
              <li key={i}>{c.controlKey}{c.reason ? ` — ${c.reason}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      {(tp.blocked?.length || tp.approvalRequired?.length) ? (
        <div className="focus-governance-section">
          <span className="g-label">Tool policy</span>
          {tp.blocked?.length ? <div className="g-tools">Blocked: {tp.blocked.join(', ')}</div> : null}
          {tp.approvalRequired?.length ? <div className="g-tools">Approval required: {tp.approvalRequired.join(', ')}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
