import { ReconciliationStudio } from './ReconciliationStudio'

/**
 * Reconciliation tab → the Reconciliation Studio (redesigned matrix / verdict / timeline / report
 * view). Thin wrapper so WorkDetailPage's mount point stays stable.
 */
export function ReconciliationTab({ workItemId, focusRunId }: { workItemId: string; focusRunId?: string | null }) {
  return <ReconciliationStudio workItemId={workItemId} focusRunId={focusRunId} />
}
