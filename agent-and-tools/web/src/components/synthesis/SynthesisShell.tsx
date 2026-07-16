"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  LayoutDashboard,
  Lightbulb,
  Network,
  MessagesSquare,
  FileText,
  Binary,
  Boxes,
  ArrowLeft,
  WifiOff,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface SynNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
}

export const SYN_NAV: SynNavItem[] = [
  { href: "/synthesis/hub", label: "Workspace Hub", icon: Home, hint: "All initiatives" },
  { href: "/synthesis/overview", label: "System Overview", icon: LayoutDashboard, hint: "Health & activity" },
  { href: "/synthesis/ideas", label: "Idea Board", icon: Lightbulb, hint: "Explore & synthesize" },
  { href: "/synthesis/discovery", label: "Discovery Board", icon: Network, hint: "Reduce unknowns" },
  { href: "/synthesis/rooms", label: "Assumption Rooms", icon: MessagesSquare, hint: "Validate claims" },
  { href: "/synthesis/spec", label: "Spec & Traceability", icon: FileText, hint: "Converge & trace" },
  { href: "/synthesis/logic", label: "Logic Console", icon: Binary, hint: "Consistency" },
  { href: "/synthesis/use-cases", label: "Use-Case Registry", icon: Boxes, hint: "Maturity" },
];

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const set = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    set();
    window.addEventListener("online", set);
    window.addEventListener("offline", set);
    return () => {
      window.removeEventListener("online", set);
      window.removeEventListener("offline", set);
    };
  }, []);
  return online;
}

function SidebarLink({ item, active }: { item: SynNavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center justify-center lg:justify-start gap-3 px-3 lg:px-4 py-2.5 rounded-lg text-sm transition-all group",
        active
          ? "bg-secondary-container text-on-secondary-container font-medium"
          : "text-on-surface-variant hover:bg-surface-container-high",
      ].join(" ")}
    >
      <Icon
        size={18}
        strokeWidth={active ? 2 : 1.8}
        className="shrink-0"
      />
      <span className="hidden lg:block flex-1 min-w-0 truncate">{item.label}</span>
    </Link>
  );
}

/**
 * Full-bleed application chrome for Synthesis: a 260px left rail of primary
 * surfaces + a sticky top header, matching the "Ethos & Form" mockups. The
 * offline banner drives the app-wide sync-interrupted boundary.
 */
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
  const active = SYN_NAV.filter((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const pageTitle = title ?? active?.label ?? "Synthesis";

  return (
    <div className="synthesis-root flex h-screen w-full overflow-hidden">
      {/* Left rail */}
      <aside className="w-[72px] lg:w-[260px] h-full bg-surface-container-low border-r border-outline-variant flex flex-col shrink-0 z-20">
        <div className="h-20 flex items-center justify-center lg:justify-start px-3 lg:px-7 gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary text-on-primary flex items-center justify-center">
            <Sparkles size={18} strokeWidth={2} />
          </div>
          <div className="hidden lg:flex flex-col">
            <span className="font-display font-semibold text-lg tracking-tight text-on-surface leading-none">
              Synthesis
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant mt-1">
              Pre-development
            </span>
          </div>
        </div>

        <nav className="flex-1 py-3 px-3 flex flex-col gap-0.5 overflow-y-auto">
          {SYN_NAV.map((item) => (
            <SidebarLink key={item.href} item={item} active={active?.href === item.href} />
          ))}
        </nav>

        <div className="p-4 border-t border-outline-variant">
          <Link
            href="/"
            className="flex items-center justify-center lg:justify-start gap-2 px-3 py-2 rounded-lg text-sm text-on-surface-variant hover:bg-surface-container-high transition-all"
          >
            <ArrowLeft size={16} strokeWidth={1.8} />
            <span className="hidden lg:inline">Back to platform</span>
          </Link>
        </div>
      </aside>

      {/* Main column */}
      <main className="flex-1 h-full flex flex-col relative overflow-hidden bg-background">
        <header className="min-h-20 syn-glass border-b border-outline-variant px-4 lg:px-10 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0 z-10 sticky top-0">
          <div className="flex items-center gap-4 min-w-0">
            <h2 className="font-display font-semibold text-xl text-on-surface truncate">
              {pageTitle}
            </h2>
            <span
              className={[
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider",
                online
                  ? "bg-secondary-container/60 text-on-secondary-container"
                  : "bg-error-container text-on-error-container",
              ].join(" ")}
            >
              <span
                className={[
                  "w-1.5 h-1.5 rounded-full",
                  online ? "bg-secondary syn-pulse-dot" : "bg-error",
                ].join(" ")}
              />
              {online ? "Synced" : "Offline"}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">{headerActions}</div>
        </header>

        {!online ? <OfflineBanner /> : null}

        <div className={fullBleed ? "flex-1 min-h-0 overflow-hidden" : "flex-1 overflow-y-auto"}>
          <div className={fullBleed ? "h-full w-full p-3 lg:p-4 syn-fade-in" : "max-w-[1280px] mx-auto w-full p-5 lg:p-10 syn-fade-in"}>{children}</div>
        </div>
      </main>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div className="bg-error-container/70 border-b border-error/30 px-10 py-2.5 flex items-center gap-2.5 text-sm text-on-error-container">
      <WifiOff size={16} strokeWidth={1.8} />
      <span className="font-medium">Sync interrupted.</span>
      <span className="text-on-error-container/80">
        You are viewing the last synced state — edits are paused until the connection returns.
      </span>
    </div>
  );
}
