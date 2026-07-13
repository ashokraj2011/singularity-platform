import { SubmissionsStudio } from './SubmissionsStudio'

/**
 * Submissions tab → the Submissions Studio (handoff + attempts + requirement coverage). Thin
 * wrapper so WorkDetailPage's mount point stays stable.
 */
export function SubmissionsTab({ workItemId, onGotoReconciliation }: { workItemId: string; onGotoReconciliation?: (runId: string) => void }) {
  return <SubmissionsStudio workItemId={workItemId} onGotoReconciliation={onGotoReconciliation} />
}
