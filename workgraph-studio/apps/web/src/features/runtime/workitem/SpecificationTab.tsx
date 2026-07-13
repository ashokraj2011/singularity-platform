import { SpecStudio } from './SpecStudio'

/**
 * Specification tab → the Spec Studio (redesigned authoring workspace). Kept as a thin wrapper so
 * WorkDetailPage's mount point stays stable; all behaviour lives in SpecStudio.
 */
export function SpecificationTab({ workItemId }: { workItemId: string }) {
  return <SpecStudio workItemId={workItemId} />
}
