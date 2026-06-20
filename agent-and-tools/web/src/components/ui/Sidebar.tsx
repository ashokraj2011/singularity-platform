"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  LayoutDashboard, Wrench, Play, Users,
  GitBranch, Layers, ScrollText, ShieldCheck, Activity, Brain,
  ChevronLeft, ChevronRight, DollarSign, Cpu, WandSparkles,
  Bot, Hammer, Inbox, Network, Route, Workflow, Zap,
  Database, FileText, Globe, Link2, Package, Puzzle, ClipboardCheck,
} from "lucide-react";

const domains = [
  { label: "Home",       href: "/",           icon: LayoutDashboard },
  { label: "Operations", href: "/operations", icon: Network },
  { label: "Agents",     href: "/agents",     icon: Bot },
  { label: "Workflows",  href: "/workflows",  icon: Workflow },
  { label: "Workbench",  href: "/workbench",  icon: Wrench },
  { label: "Foundry",    href: "/foundry",    icon: Hammer },
  { label: "Identity",   href: "/identity",   icon: Users },
];

const agentRuntime = [
  { label: "Agent Studio",        href: "/agents/studio",       icon: Bot },
  { label: "Capabilities",        href: "/capabilities",        icon: GitBranch },
  { label: "Tools",               href: "/tools",               icon: Wrench },
  { label: "Executions",          href: "/executions",          icon: Play },
  { label: "Behavior Profiles",   href: "/prompt-profiles",     icon: Layers },
  { label: "Prompt Workbench",    href: "/prompt-workbench",    icon: WandSparkles },
  { label: "Instruction Blocks",  href: "/prompt-layers",       icon: ScrollText },
  { label: "Tool Grants",         href: "/tool-grants",         icon: ShieldCheck },
  { label: "Runtime Receipts",    href: "/runtime-executions",  icon: Activity },
  { label: "Memory",              href: "/memory",              icon: Brain },
];

const workflowOperate = [
  { label: "Planner", href: "/workflows/planner", icon: Route },
  { label: "Inbox", href: "/workflows/inbox", icon: Inbox },
  { label: "Work Hub", href: "/work-items", icon: Network },
  { label: "Start Workflow", href: "/workflows/run", icon: Play },
  { label: "Runs", href: "/runs", icon: Activity },
  { label: "Run History", href: "/workflows/history", icon: FileText },
  { label: "Runtime", href: "/workflows/runtime", icon: Zap },
  { label: "Artifacts", href: "/workflows/artifacts/explorer", icon: Package },
];

const workflowAuthoring = [
  { label: "Workflow Manager", href: "/workflows/templates", icon: Workflow },
  { label: "Metadata", href: "/workflows/metadata", icon: Database },
  { label: "Artifact Studio", href: "/workflows/artifacts", icon: ScrollText },
  { label: "Node Types", href: "/workflows/node-types", icon: Puzzle },
  { label: "Variables", href: "/identity/variables", icon: Globe },
  { label: "Connectors", href: "/workflows/connectors", icon: Link2 },
  { label: "LLM Routing", href: "/llm-settings", icon: Cpu },
];

const workbenchRuntime = [
  { label: "Cockpit",       href: "/workbench/cockpit",      icon: Wrench },
  { label: "Loop Theater",  href: "/workbench/loop-theater", icon: Play },
  { label: "Governance",    href: "/workbench/governance",   icon: ShieldCheck },
  { label: "Artifacts",     href: "/workbench/artifacts",    icon: ScrollText },
];

const foundryRuntime = [
  { label: "Generation Cockpit", href: "/foundry", icon: Hammer },
  { label: "Run History", href: "/foundry/history", icon: Activity },
  { label: "Artifacts", href: "/foundry/artifacts", icon: Package },
  { label: "Gaps", href: "/foundry/gaps", icon: ShieldCheck },
  { label: "LLM Tasks", href: "/foundry/llm-tasks", icon: Cpu },
  { label: "Receipts", href: "/foundry/receipts", icon: FileText },
  { label: "Repos", href: "/foundry/repos", icon: GitBranch },
  { label: "Change Plans", href: "/foundry/change-plans", icon: Route },
  { label: "Verification", href: "/foundry/verification", icon: ClipboardCheck },
];

const identityAdmin = [
  { label: "Dashboard", href: "/identity/dashboard", icon: LayoutDashboard },
  { label: "Users", href: "/identity/users", icon: Users },
  { label: "Teams", href: "/identity/teams", icon: Network },
  { label: "Roles", href: "/identity/roles", icon: ShieldCheck },
  { label: "Capabilities", href: "/identity/capabilities", icon: GitBranch },
  { label: "Permissions", href: "/identity/permissions", icon: ShieldCheck },
  { label: "Variables", href: "/identity/variables", icon: Globe },
];

const governance = [
  { label: "Engine",       href: "/engine",       icon: Zap },
  { label: "LLM Settings", href: "/llm-settings", icon: Cpu },
  { label: "Audit",        href: "/audit",         icon: ShieldCheck },
  { label: "Eval Curation", href: "/audit/curation", icon: ClipboardCheck },
  { label: "Cost",         href: "/cost",          icon: DollarSign },
];

type ItemDef = { label: string; href: string; icon: typeof LayoutDashboard };
type NavSection = { label: string; items: ItemDef[] };

function NavItem({
  label, href, icon: Icon, active, collapsed,
}: ItemDef & { active: boolean; collapsed: boolean }) {
  return (
    <Link href={href} className="block">
      <div
        className={`nav-item${active ? " active" : ""}`}
        title={collapsed ? label : undefined}
        style={collapsed ? { padding: "8px", justifyContent: "center" } : undefined}
      >
        {/* Active right-edge indicator */}
        {active && (
          <span
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              width: 3,
              height: 20,
              borderRadius: "2px 0 0 2px",
              background: "var(--brand-green-accent)",
              boxShadow: "0 0 8px rgba(0,166,81,0.45)",
            }}
          />
        )}
        <Icon
          size={16}
          style={{ color: active ? "var(--color-primary)" : "var(--color-outline)", flexShrink: 0 }}
        />
        {!collapsed && <span>{label}</span>}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored !== null) setCollapsed(stored === "true");
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrowViewport(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  function toggle() {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }

  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);
  const canvasRoute = path.startsWith("/prompt-workbench");
  const effectiveCollapsed = collapsed || canvasRoute || narrowViewport;

  const sidebarWidth = effectiveCollapsed ? 64 : 246;
  const sections: NavSection[] = [
    { label: "Agent Runtime", items: agentRuntime },
    { label: "Workflow Operations", items: workflowOperate },
    { label: "Workflow Authoring", items: workflowAuthoring },
    { label: "Workbench Neo", items: workbenchRuntime },
    { label: "Code Foundry", items: foundryRuntime },
    { label: "Identity", items: identityAdmin },
    { label: "Governance", items: governance },
  ];

  function renderSection(section: NavSection) {
    return !effectiveCollapsed ? (
      <div key={section.label} style={{ marginTop: 16 }}>
        <p className="label-xs" style={{ padding: "0 12px", marginBottom: 6 }}>{section.label}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {section.items.map(item => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={false} />
          ))}
        </div>
      </div>
    ) : (
      <div key={section.label} style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
        {section.items.map(item => (
          <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={true} />
        ))}
      </div>
    );
  }

  return (
    <aside
      className="shell-sidebar"
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        maxWidth: sidebarWidth,
        flexBasis: sidebarWidth,
      }}
    >

      {/* ── Brand header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: effectiveCollapsed ? "center" : "space-between",
          gap: effectiveCollapsed ? 0 : 12,
          padding: effectiveCollapsed ? "14px 10px" : "16px 14px 12px",
          borderBottom: "1px solid rgba(245,242,234,0.08)",
          flexShrink: 0,
        }}
      >
        {/* Logo + wordmark (hidden when collapsed) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minWidth: 0,
            opacity: effectiveCollapsed ? 0 : 1,
            transition: "opacity 0.2s",
            pointerEvents: effectiveCollapsed ? "none" : "auto",
            width: effectiveCollapsed ? 0 : "auto",
            overflow: "hidden",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/singularity-mark.png"
            alt="Singularity"
            width={40}
            height={40}
            style={{
              flexShrink: 0,
              filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.18))",
              userSelect: "none",
            }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/singularity-logo.png" }}
          />
          <div style={{ minWidth: 0, overflow: "hidden" }}>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                color: "var(--color-on-surface)",
                letterSpacing: "0.04em",
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              Singularity
            </h2>
            <p
              style={{
                fontSize: "0.5625rem",
                fontWeight: 600,
                textTransform: "uppercase",
                // Was 0.18em — rendered "GOVERNED AGENTIC DELIVERY" at
                // ~190px, but the brand-text column inside a 236px sidebar
                // only has ~110px after the logo + collapse button take
                // their share, so it wrapped word-by-word onto three lines.
                // 0.10em keeps the airy microcaps feel and fits one line.
                letterSpacing: "0.10em",
                color: "var(--color-outline)",
                opacity: 0.85,
                marginTop: 2,
                marginBottom: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title="Governed Agentic Delivery"
            >
              Governed Agentic Delivery
            </p>
          </div>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={toggle}
          title={effectiveCollapsed ? (canvasRoute || narrowViewport ? "Compact navigation" : "Expand sidebar") : "Collapse sidebar"}
          disabled={canvasRoute || narrowViewport}
          style={{
            width: 32, height: 32, borderRadius: 8, border: "none",
            background: "var(--color-surface-container)", cursor: canvasRoute || narrowViewport ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--color-primary)", transition: "all 0.15s",
            opacity: canvasRoute || narrowViewport ? 0.55 : 1,
            flexShrink: 0,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,132,61,0.10)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-container)"; }}
        >
          {effectiveCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 8px" }}>

        {/* Domains section */}
        {!effectiveCollapsed && (
          <p className="label-xs" style={{ padding: "0 12px", marginBottom: 6 }}>Platform</p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {domains.map(item => {
            const active = isActive(item.href);
            return (
              <div key={item.href}>
                <NavItem {...item} active={active} collapsed={effectiveCollapsed} />
              </div>
            );
          })}
        </div>

        {sections.map(renderSection)}
      </nav>

      {/* ── Footer ── */}
      {!effectiveCollapsed && (
        <div
          style={{
            padding: "8px 16px 16px",
            borderTop: "1px solid rgba(245,242,234,0.08)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6875rem",
            color: "var(--color-outline)",
            opacity: 0.6,
            flexShrink: 0,
          }}
        >
          v1.0.0
        </div>
      )}
    </aside>
  );
}
