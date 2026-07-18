"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BadgeDollarSign,
  Binary,
  BookOpen,
  Boxes,
  Braces,
  FileText,
  GitFork,
  Home,
  Inbox,
  FileInput,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Map,
  MessagesSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Scale,
  Sparkles,
  Ticket,
  Target,
  TrendingUp,
  ShieldCheck,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

export interface SynNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  phase: "Orient" | "Explore" | "Decide" | "Specify" | "Govern";
}

export const SYN_NAV: SynNavItem[] = [
  { href: "/synthesis/hub", label: "Initiative Portfolio", icon: Home, hint: "Portfolio and active initiatives", phase: "Orient" },
  { href: "/synthesis/overview", label: "Initiative Overview", icon: LayoutDashboard, hint: "Signals, budgets, and activity", phase: "Orient" },
  { href: "/synthesis/business", label: "Business Alignment", icon: Target, hint: "Objectives, milestones, sponsor consent, and risk", phase: "Orient" },
  { href: "/synthesis/desk", label: "Decision Desk", icon: Inbox, hint: "Ranked decisions and exceptions", phase: "Orient" },
  { href: "/synthesis/intake", label: "Source Intake", icon: FileInput, hint: "Interview or validate a document set", phase: "Orient" },
  { href: "/synthesis/ideas", label: "Idea Board", icon: Lightbulb, hint: "Spatial capture, facts, and synthesis", phase: "Explore" },
  { href: "/synthesis/journey", label: "Journey Map", icon: Map, hint: "Customer stages, pain, and opportunity", phase: "Explore" },
  { href: "/synthesis/discovery", label: "Discovery", icon: Network, hint: "Reduce unknowns", phase: "Explore" },
  { href: "/synthesis/rooms", label: "Assumption Rooms", icon: MessagesSquare, hint: "Validate governed claims", phase: "Explore" },
  { href: "/synthesis/options", label: "Solution Options", icon: ListTree, hint: "Compare durable solution options", phase: "Decide" },
  { href: "/synthesis/decisions", label: "Decision Records", icon: Scale, hint: "Govern trade-offs and approvals", phase: "Decide" },
  { href: "/synthesis/wiki", label: "Evidence Wiki", icon: BookOpen, hint: "Living synthesis and evidence", phase: "Decide" },
  { href: "/synthesis/diagrams", label: "System Diagrams", icon: GitFork, hint: "Map systems and decisions", phase: "Specify" },
  { href: "/synthesis/pseudocode", label: "Pseudocode", icon: Braces, hint: "Shape logic before implementation", phase: "Specify" },
  { href: "/synthesis/spec", label: "Specification", icon: FileText, hint: "Converge and trace", phase: "Specify" },
  { href: "/synthesis/logic", label: "Logic Checks", icon: Binary, hint: "Check consistency", phase: "Specify" },
  { href: "/synthesis/use-cases", label: "Use Cases", icon: Boxes, hint: "Track maturity", phase: "Specify" },
  { href: "/synthesis/generate", label: "Generate Work", icon: Ticket, hint: "Compile the specification and generate work", phase: "Govern" },
  { href: "/synthesis/economics", label: "Delivery Economics", icon: BadgeDollarSign, hint: "Budget, token use, and timeline", phase: "Govern" },
  { href: "/synthesis/learning", label: "Learning & Change", icon: TrendingUp, hint: "Belief drift and governed change", phase: "Govern" },
  { href: "/synthesis/pilot", label: "Pilot Proof", icon: ShieldCheck, hint: "End-to-end readiness and evidence", phase: "Govern" },
];

const PHASES: SynNavItem["phase"][] = ["Orient", "Explore", "Decide", "Specify", "Govern"];

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

export function SynthesisShell({
  children,
  title,
  headerActions,
  fullBleed = false,
}: {
  children: ReactNode;
  title?: string;
  headerActions?: ReactNode;
  fullBleed?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const online = useOnline();
  const [collapsed, setCollapsed] = useState(false);
  const active = useMemo(() => SYN_NAV
    .filter(item => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0], [pathname]);
  const pageTitle = title ?? active?.label ?? "Synthesis";

  return (
    <div className="synthesis-root flex h-screen min-h-0 w-full flex-col overflow-hidden bg-surface">
      <header className="syn-appbar flex h-[58px] shrink-0 items-center border-b border-outline-variant bg-surface-container-lowest px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary text-on-secondary"><Sparkles size={18} /></span>
          <div className="min-w-0">
            <div className="truncate text-sm font-black text-on-surface">Singularity Synthesis</div>
            <div className="hidden text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant sm:block">From ambiguity to executable intent</div>
          </div>
        </div>
        <div className="mx-auto hidden h-full items-center lg:flex" aria-label="Synthesis phases">
          {PHASES.map((phase, index) => (
            <div key={phase} className={`flex h-full items-center gap-2 border-b-2 px-5 text-xs font-bold ${active?.phase === phase ? "border-secondary text-secondary" : "border-transparent text-on-surface-variant"}`}>
              <span className="grid h-5 w-5 place-items-center rounded-full border border-outline-variant text-[9px]">{index + 1}</span>{phase}
            </div>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 text-xs font-semibold sm:inline-flex ${online ? "text-emerald-700" : "text-error"}`}
            title={online ? "Browser network is online. Save status is shown by each workspace action." : "Browser network is offline."}
          >
            {online ? <Wifi size={14} /> : <WifiOff size={14} />}{online ? "Online" : "Offline"}
          </span>
          <Link href="/" className="icon-button" title="Back to Platform" aria-label="Back to Platform"><ArrowLeft size={16} /></Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className={`syn-sidebar hidden shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest md:flex ${collapsed ? "w-[58px]" : "w-[220px]"}`}>
          <div className="flex h-11 items-center justify-end border-b border-outline-variant px-2">
            <button type="button" className="icon-button" onClick={() => setCollapsed(value => !value)} title={collapsed ? "Expand navigation" : "Collapse navigation"} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Synthesis workspaces">
            {PHASES.map(phase => (
              <section key={phase} className="mb-4">
                {!collapsed ? <div className="px-2 pb-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-on-surface-variant">{phase}</div> : null}
                <div className="space-y-1">
                  {SYN_NAV.filter(item => item.phase === phase).map(item => {
                    const Icon = item.icon;
                    const isActive = active?.href === item.href;
                    return (
                      <Link key={item.href} href={item.href} title={collapsed ? item.label : item.hint} aria-current={isActive ? "page" : undefined} className={`group flex h-9 items-center gap-2.5 rounded-md px-2 text-xs font-semibold transition-colors ${isActive ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"}`}>
                        <span className="grid h-6 w-6 shrink-0 place-items-center"><Icon size={15} /></span>
                        {!collapsed ? <span className="truncate">{item.label}</span> : null}
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
          {!collapsed ? <div className="border-t border-outline-variant px-4 py-3 text-[10px] leading-4 text-on-surface-variant">Changes remain attached to the selected initiative and its evidence spine.</div> : null}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="syn-workbar flex min-h-[54px] shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant bg-surface-container-lowest px-3 py-2 md:px-5">
            <div className="min-w-0">
              <div className="text-[9px] font-black uppercase tracking-[0.14em] text-on-surface-variant">{active?.phase ?? "Workspace"}</div>
              <h1 className="truncate text-base font-black text-on-surface">{pageTitle}</h1>
            </div>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{headerActions}</div>
          </div>
          <nav className="flex shrink-0 overflow-x-auto border-b border-outline-variant bg-surface-container-lowest px-2 md:hidden" aria-label="Synthesis workspaces">
            {SYN_NAV.map(item => {
              const Icon = item.icon;
              const isActive = active?.href === item.href;
              return <Link key={item.href} href={item.href} className={`inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[11px] font-bold ${isActive ? "border-secondary text-secondary" : "border-transparent text-on-surface-variant"}`}><Icon size={14} />{item.label}</Link>;
            })}
          </nav>
          {!online ? <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"><strong>Offline.</strong> Local edits remain available; server-backed synthesis will resume after reconnecting.</div> : null}
          <main className={`min-h-0 flex-1 ${fullBleed ? "overflow-hidden p-3" : "overflow-y-auto p-4 md:p-6"}`}>
            <div className={fullBleed ? "h-full min-h-0" : "mx-auto w-full max-w-[1400px]"}>{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
