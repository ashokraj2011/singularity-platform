"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, Download, FileCheck2, Lightbulb, ShieldCheck } from "lucide-react";
import { SynthesisShell } from "../SynthesisShell";
import { NoProjectSelected, ProjectPicker, useSelectedProjectId } from "../ProjectPicker";
import { useClaims, useProject, useProjectSpec } from "../hooks/useSynthesis";
import { SynError, SynSkeleton } from "../ui/kit";

export function ProjectWikiScreen() {
  const pathname = usePathname() ?? "/synthesis/wiki";
  const projectId = useSelectedProjectId();
  return <SynthesisShell title="Evidence Wiki" headerActions={<ProjectPicker pathname={pathname} />}>{projectId ? <WikiDocument projectId={projectId} /> : <NoProjectSelected surface="Evidence Wiki" />}</SynthesisShell>;
}

function WikiDocument({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);
  const claimsQ = useClaims(projectId);
  const specQ = useProjectSpec(projectId);
  const claims = claimsQ.data?.items ?? [];
  const spec = specQ.data?.package;
  const strongClaims = useMemo(() => claims.filter(claim => (claim.mean ?? 0.5) >= 0.65).sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0)), [claims]);

  function download() {
    const lines = [`# ${projectQ.data?.name ?? "Initiative"}`, "", projectQ.data?.mission ?? "", "", "## Working facts", ...strongClaims.map(claim => `- ${claim.statement}`), "", "## Requirements", ...(spec?.requirements ?? []).map(item => `- **${item.priority}** ${item.statement}`), "", "## Decisions", ...(spec?.decisions ?? []).map(item => `- **${item.title}:** ${item.decision}`)];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${projectQ.data?.code ?? "initiative"}-wiki.md`; anchor.click(); URL.revokeObjectURL(url);
  }

  if (projectQ.error || claimsQ.error) return <SynError message="The initiative knowledge record could not be loaded." />;
  if (projectQ.isLoading || claimsQ.isLoading) return <SynSkeleton rows={6} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,820px)_260px] lg:justify-center">
      <aside className="hidden border-r border-outline-variant pr-5 lg:block"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-on-surface-variant">On this page</div>{["Purpose", "Working facts", "Requirements", "Decisions", "Open questions"].map(label => <a key={label} href={`#${label.toLowerCase().replaceAll(" ", "-")}`} className="mt-2 block text-xs font-semibold text-on-surface-variant hover:text-secondary">{label}</a>)}</aside>
      <article className="min-w-0 bg-surface-container-lowest px-5 py-7 shadow-sm md:px-10 md:py-10">
        <div className="flex items-start justify-between gap-4 border-b border-outline-variant pb-6"><div><div className="text-[10px] font-black uppercase tracking-[0.14em] text-secondary">Living initiative record</div><h2 className="mt-2 text-3xl font-black text-on-surface">{projectQ.data?.name}</h2><p className="mt-3 max-w-2xl text-base leading-7 text-on-surface-variant">{projectQ.data?.mission || "This initiative does not yet have a mission statement."}</p></div><button type="button" onClick={download} className="icon-button" title="Export as Markdown" aria-label="Export as Markdown"><Download size={16} /></button></div>
        <WikiSection id="purpose" icon={BookOpen} title="Purpose"><p>{spec?.analysis.problem || projectQ.data?.mission || "Purpose is still being shaped."}</p>{spec?.analysis.goals?.length ? <ul>{spec.analysis.goals.map(goal => <li key={goal.text}>{goal.text}{goal.metric ? ` - measured by ${goal.metric}` : ""}</li>)}</ul> : null}</WikiSection>
        <WikiSection id="working-facts" icon={ShieldCheck} title="Working facts"><p className="text-xs text-on-surface-variant">Evidence-backed claims with at least 65% posterior confidence.</p><ol className="mt-4 space-y-3">{strongClaims.map(claim => <li key={claim.id} className="border-l-2 border-emerald-500 pl-3"><p className="font-semibold text-on-surface">{claim.statement}</p><span className="text-xs text-on-surface-variant">{Math.round((claim.mean ?? 0.5) * 100)}% confidence · {claim.estimateCount ?? 0} estimates</span></li>)}</ol></WikiSection>
        <WikiSection id="requirements" icon={FileCheck2} title="Requirements"><div className="space-y-3">{(spec?.requirements ?? []).map(item => <div key={item.id} className="grid gap-2 border-b border-outline-variant pb-3 sm:grid-cols-[64px_1fr]"><span className="text-[10px] font-black text-secondary">{item.priority}</span><div><p className="font-semibold text-on-surface">{item.statement}</p>{item.acceptanceCriteria?.map(value => <p key={value} className="mt-1 text-xs text-on-surface-variant">✓ {value}</p>)}</div></div>)}</div></WikiSection>
        <WikiSection id="decisions" icon={Lightbulb} title="Decisions"><div className="space-y-4">{(spec?.decisions ?? []).map(item => <div key={item.id}><div className="flex items-center gap-2"><h4 className="font-bold text-on-surface">{item.title}</h4><span className="text-[10px] font-bold uppercase text-secondary">{item.status}</span></div><p className="mt-1 text-sm text-on-surface-variant">{item.decision}</p></div>)}</div></WikiSection>
        <WikiSection id="open-questions" icon={Lightbulb} title="Open questions"><ul>{claims.filter(claim => (claim.mean ?? 0.5) < 0.65).slice(0, 8).map(claim => <li key={claim.id}>{claim.statement}</li>)}</ul></WikiSection>
      </article>
      <aside className="space-y-5"><div className="border-l-2 border-secondary pl-4"><div className="text-[10px] font-black uppercase tracking-[0.12em] text-secondary">AI synthesis</div><p className="mt-2 text-sm leading-6 text-on-surface-variant">{strongClaims.length} facts are strong enough to inform design. {(spec?.requirements ?? []).length} requirements and {(spec?.decisions ?? []).length} decisions are linked to this revision.</p></div><div className="text-xs leading-5 text-on-surface-variant"><strong className="text-on-surface">Revision {specQ.data?.revision ?? 0}</strong><br />Last updated {specQ.data?.updatedAt ? new Date(specQ.data.updatedAt).toLocaleString() : "not yet"}</div></aside>
    </div>
  );
}

function WikiSection({ id, icon: Icon, title, children }: { id: string; icon: typeof BookOpen; title: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-6 border-b border-outline-variant py-8 last:border-0"><div className="mb-4 flex items-center gap-2"><Icon size={17} className="text-secondary" /><h3 className="text-lg font-black text-on-surface">{title}</h3></div><div className="wiki-copy text-sm leading-7 text-on-surface-variant">{children}</div></section>;
}
