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
  WifiOff,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { StatusPill } from "@/components/ui/primitives";

export interface SynNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
}

export const SYN_NAV: SynNavItem[] = [
  { href: "/synthesis/hub", label: "Workspace Hub", icon: Home, hint: "All initiatives" },
  { href: "/synthesis/overview", label: "Overview", icon: LayoutDashboard, hint: "Health and activity" },
  { href: "/synthesis/ideas", label: "Idea Board", icon: Lightbulb, hint: "Explore and synthesize" },
  { href: "/synthesis/discovery", label: "Discovery", icon: Network, hint: "Reduce unknowns" },
  { href: "/synthesis/rooms", label: "Assumption Rooms", icon: MessagesSquare, hint: "Validate claims" },
  { href: "/synthesis/spec", label: "Specification", icon: FileText, hint: "Converge and trace" },
  { href: "/synthesis/logic", label: "Logic", icon: Binary, hint: "Check consistency" },
  { href: "/synthesis/use-cases", label: "Use Cases", icon: Boxes, hint: "Track maturity" },
];

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
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

function JourneyTab({ item, active }: { item: SynNavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={item.hint}
      className={[
        "relative inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition-colors",
        active
          ? "border-[var(--accent-workflow)] bg-[var(--accent-workflow-soft)] text-[var(--accent-workflow)]"
          : "border-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface",
      ].join(" ")}
    >
      <Icon size={15} strokeWidth={active ? 2.2 : 1.9} />
      <span>{item.label}</span>
    </Link>
  );
}

/**
 * Synthesis sub-navigation inside the canonical Platform Web shell. It keeps
 * discovery stages close at hand without introducing a second app sidebar,
 * topbar, font stack, or theme.
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
  const active = SYN_NAV.filter(item => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0];
  const pageTitle = title ?? active?.label ?? "Synthesis";

  return (
    <div className={`synthesis-root w-full ${fullBleed ? "flex h-full min-h-0 flex-col" : ""}`}>
      <div className="mb-4 shrink-0 border-b border-outline-variant">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-lg"
              style={{ background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)" }}
            >
              <Sparkles size={18} strokeWidth={2.1} />
            </span>
            <div className="min-w-0">
              <div className="label-xs mb-0.5">Synthesis workspace</div>
              <h1 className="truncate text-xl font-black text-on-surface">{pageTitle}</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <StatusPill state={online ? "ready" : "offline"} label={online ? "Synced" : "Offline"} />
            {headerActions}
          </div>
        </div>

        <nav className="flex max-w-full items-center overflow-x-auto" aria-label="Synthesis journey">
          {SYN_NAV.map(item => (
            <JourneyTab key={item.href} item={item} active={active?.href === item.href} />
          ))}
        </nav>
      </div>

      {!online ? <OfflineBanner /> : null}

      <div className={fullBleed ? "min-h-0 flex-1" : "mx-auto w-full max-w-[1320px]"}>
        {children}
      </div>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <WifiOff size={16} className="mt-0.5 shrink-0" />
      <span><strong>Sync interrupted.</strong> You are viewing the last synced state; editing resumes when the connection returns.</span>
    </div>
  );
}
