"use client";

import { useState } from "react";
import { Plus, Pin, Trash2, ArrowLeft } from "lucide-react";
import { workgraphFetch } from "@/lib/workgraph";
import { useSyn } from "@/components/synthesis/hooks/useSynthesis";
import { SynButton, SynChip, SynSkeleton, SynError, EmptyState, MonoMeta } from "@/components/synthesis/ui/kit";

/**
 * Structured-block editor for an own-content document. Blocks are LIVE until pinned;
 * entering a frozen state (via a lifecycle transition) forces every block PINNED on the
 * backend. Spec-bound docs (PRD/BRD) are read-only here — their content lives in the
 * SpecificationVersion.
 */
interface Block { id: string; ordinal: number; blockType: string; mode: string; content: Record<string, unknown> }
interface DocVersion { id: string; version: number; status: string; blocks: Block[] }
interface FullDoc { id: string; docType: string; title: string; status: string; specificationVersionId?: string | null; versions: DocVersion[] }

const BLOCK_TYPES = ["NARRATIVE", "REQUIREMENT", "ACCEPTANCE", "DECISION", "RISK", "OBJECTIVE", "METRIC", "CITATION"] as const;
const NEXT_STATUS: Record<string, string[]> = {
  DRAFT: ["IN_REVIEW"], IN_REVIEW: ["APPROVED", "CHANGES_REQUESTED"], CHANGES_REQUESTED: ["IN_REVIEW"], APPROVED: ["PUBLISHED"],
};
const blockText = (c: Record<string, unknown>) => (typeof c.text === "string" ? c.text : JSON.stringify(c));

export function DocumentEditor({ documentId, onBack }: { documentId: string; onBack: () => void }) {
  const doc = useSyn<FullDoc>(`/synthesis/documents/${documentId}`);
  const [blockType, setBlockType] = useState<string>("NARRATIVE");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function op(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await doc.mutate(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); } finally { setBusy(false); }
  }

  if (doc.isLoading) return <SynSkeleton rows={5} />;
  if (doc.error) return <SynError message={doc.error instanceof Error ? doc.error.message : "Failed to load document."} />;
  const d = doc.data;
  if (!d) return null;
  const version = d.versions?.[0];
  const specBound = Boolean(d.specificationVersionId);
  const editable = ["DRAFT", "CHANGES_REQUESTED"].includes(d.status);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="icon-button" title="Back to documents"><ArrowLeft size={15} /></button>
        <SynChip tone="tertiary">{d.docType}</SynChip>
        <SynChip tone="neutral">{d.status.toLowerCase()}</SynChip>
        <span className="min-w-0 truncate text-sm font-semibold text-on-surface">{d.title}</span>
        <div className="ml-auto flex gap-1.5">
          {(NEXT_STATUS[d.status] ?? []).map((to) => (
            <SynButton key={to} variant="ghost" disabled={busy} onClick={() => op(() => workgraphFetch(`/synthesis/documents/${documentId}/transition`, { method: "POST", body: JSON.stringify({ to }) }))}>
              {to.replace("_", " ").toLowerCase()}
            </SynButton>
          ))}
        </div>
      </div>
      {error ? <SynError message={error} /> : null}

      {specBound ? (
        <p className="rounded-lg bg-surface-container px-3 py-2 text-xs text-on-surface-variant">Spec-bound document — its content is the SpecificationVersion and is edited there, not as blocks.</p>
      ) : !version ? (
        <EmptyState title="No version yet" />
      ) : (
        <>
          {version.blocks.length === 0 ? (
            <p className="px-1 py-3 text-xs text-on-surface-variant">No blocks yet. Add one below, or ask an agent to draft.</p>
          ) : version.blocks.map((b) => (
            <div key={b.id} className="group rounded-lg bg-surface-container px-3 py-2">
              <div className="mb-1 flex items-center gap-2">
                <MonoMeta>{b.blockType}</MonoMeta>
                <SynChip tone={b.mode === "PINNED" ? "secondary" : "neutral"}>{b.mode.toLowerCase()}</SynChip>
                {editable && b.mode !== "PINNED" ? (
                  <div className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" title="Pin" disabled={busy} onClick={() => op(() => workgraphFetch(`/synthesis/documents/${documentId}/blocks/${b.id}/pin`, { method: "POST" }))} className="icon-button"><Pin size={13} /></button>
                    <button type="button" title="Remove" disabled={busy} onClick={() => op(() => workgraphFetch(`/synthesis/documents/${documentId}/blocks/${b.id}`, { method: "DELETE" }))} className="icon-button text-error"><Trash2 size={13} /></button>
                  </div>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-xs text-on-surface">{blockText(b.content)}</p>
            </div>
          ))}
          {editable ? (
            <div className="flex gap-1.5 pt-1">
              <select value={blockType} onChange={(e) => setBlockType(e.target.value)} className="h-8 rounded-lg border border-outline-variant bg-surface-container px-2 text-xs text-on-surface">
                {BLOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Block text…" className="h-8 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container px-2 text-xs text-on-surface" />
              <SynButton variant="secondary" icon={Plus} disabled={busy || !text.trim()} onClick={() => text.trim() && op(async () => {
                await workgraphFetch(`/synthesis/documents/${documentId}/blocks`, { method: "POST", body: JSON.stringify({ blockType, content: { text: text.trim() } }) });
                setText("");
              })}>Add</SynButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
