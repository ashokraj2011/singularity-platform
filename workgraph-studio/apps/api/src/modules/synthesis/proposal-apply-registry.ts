/**
 * Synthesis Studio — the typed-tool apply registry (R1A Proposals phase). The ONLY place a
 * proposal item mutates a domain entity, invoked exclusively on a human ACCEPT. Item content
 * is UNTRUSTED (agents emit it, possibly prompt-injected), so every verb re-validates and
 * applies through a tenant-scoped domain SERVICE — never a raw table write. Unknown verbs
 * throw (they land as the Agents phase wires them); a thrown apply leaves the item
 * accepted-but-not-applied with the error recorded, never a partial silent mutation.
 */
import { updateBlock, addBlock } from './block.service'

export interface ApplyContext { actor: string }
export interface ApplyResult { applied: boolean; receipt: Record<string, unknown> }

export interface ProposalItemLike {
  id: string
  kind: string
  targetEntityType: string | null
  targetEntityId: string | null
  diff: unknown
  editedDiff: unknown
}

type ApplyFn = (item: ProposalItemLike, ctx: ApplyContext) => Promise<ApplyResult>

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const stamp = (verb: string, extra: Record<string, unknown>, actor: string) => ({ verb, by: actor, ...extra })

const REGISTRY: Record<string, ApplyFn> = {
  EDIT_DOC_BLOCK: async (item, ctx) => {
    const diff = asRecord(item.editedDiff ?? item.diff)
    const documentId = String(diff.documentId ?? '')
    const blockId = String(diff.blockId ?? '')
    if (!documentId || !blockId) throw new Error('EDIT_DOC_BLOCK requires diff.documentId + diff.blockId')
    const updated = await updateBlock(documentId, blockId, { content: asRecord(diff.content) })
    return { applied: true, receipt: stamp('EDIT_DOC_BLOCK', { documentId, blockId: updated.id }, ctx.actor) }
  },
  ADD_DOC_BLOCK: async (item, ctx) => {
    const diff = asRecord(item.editedDiff ?? item.diff)
    const documentId = String(diff.documentId ?? '')
    if (!documentId) throw new Error('ADD_DOC_BLOCK requires diff.documentId')
    const created = await addBlock(documentId, { blockType: String(diff.blockType ?? 'NARRATIVE'), content: asRecord(diff.content) })
    return { applied: true, receipt: stamp('ADD_DOC_BLOCK', { documentId, blockId: created.id }, ctx.actor) }
  },
}

export function isAppliableVerb(kind: string): boolean {
  return kind in REGISTRY
}

export async function applyProposalItem(item: ProposalItemLike, ctx: ApplyContext): Promise<ApplyResult> {
  const fn = REGISTRY[item.kind]
  if (!fn) throw new Error(`No apply handler for proposal-item kind "${item.kind}" — agent verbs are wired in the Agents phase.`)
  return fn(item, ctx)
}
