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

type ItemDef = { label: string; href: string; icon: typeof LayoutDashboard };
type NavSection = { label: string; description: string; items: ItemDef[] };

const menuSections: NavSection[] = [
  {
    label: "Start Here",
    description: "Overview and app catalog",
    items: [
      { label: "Command Center", href: "/", icon: LayoutDashboard },
      { label: "App Catalog", href: "/control-plane", icon: Network },
    ],
  },
  {
    label: "Operations Center",
    description: "Health, topology, setup, and trust",
    items: [
      { label: "Readiness", href: "/operations/readiness", icon: Activity },
      { label: "Live App Map", href: "/operations/architecture", icon: Network },
      { label: "Access Keys", href: "/operations/access-keys", icon: ShieldCheck },
      { label: "Setup Center", href: "/operations/setup", icon: Wrench },
      { label: "Trust Evidence", href: "/operations/trust", icon: ClipboardCheck },
    ],
  },
  {
    label: "Agent Studio",
    description: "Create, govern, and run agents",
    items: [
      { label: "Create Agents", href: "/agents/studio", icon: Bot },
      { label: "Agent Profiles", href: "/agents", icon: Layers },
      { label: "Capabilities", href: "/capabilities", icon: GitBranch },
      { label: "Tools", href: "/tools", icon: Wrench },
      { label: "Tool Grants", href: "/tool-grants", icon: ShieldCheck },
      { label: "Executions", href: "/executions", icon: Play },
    ],
  },
  {
    label: "Prompts and Knowledge",
    description: "Behavior, prompts, learning, and memory",
    items: [
      { label: "Prompt Workbench", href: "/prompt-workbench", icon: WandSparkles },
      { label: "Behavior Profiles", href: "/prompt-profiles", icon: Layers },
      { label: "Instruction Blocks", href: "/prompt-layers", icon: ScrollText },
      { label: "Runtime Receipts", href: "/runtime-executions", icon: Activity },
      { label: "Learning", href: "/learning", icon: Brain },
      { label: "Memory", href: "/memory", icon: Database },
    ],
  },
  {
    label: "Workflow Operations",
    description: "Plan, route, start, and monitor work",
    items: [
      { label: "Workflow Home", href: "/workflows", icon: Workflow },
      { label: "Planner", href: "/workflows/planner", icon: Route },
      { label: "Inbox", href: "/workflows/inbox", icon: Inbox },
      { label: "Work Hub", href: "/work-items", icon: Network },
      { label: "Start Workflow", href: "/workflows/run", icon: Play },
      { label: "Runs", href: "/runs", icon: Activity },
      { label: "Run History", href: "/workflows/history", icon: FileText },
      { label: "Runtime", href: "/workflows/runtime", icon: Zap },
    ],
  },
  {
    label: "Workflow Authoring",
    description: "Design workflow assets and integrations",
    items: [
      { label: "Workflow Manager", href: "/workflows/templates", icon: Workflow },
      { label: "Metadata", href: "/workflows/metadata", icon: Database },
      { label: "Artifact Studio", href: "/workflows/artifacts", icon: ScrollText },
      { label: "Artifact Explorer", href: "/workflows/artifacts/explorer", icon: Package },
      { label: "Node Types", href: "/workflows/node-types", icon: Puzzle },
      { label: "Connectors", href: "/workflows/connectors", icon: Link2 },
    ],
  },
  {
    label: "Workbench Neo",
    description: "Story-to-delivery workspace",
    items: [
      { label: "Workbench Home", href: "/workbench", icon: Wrench },
      { label: "Cockpit", href: "/workbench/cockpit", icon: Wrench },
      { label: "Stage Chat", href: "/workbench/stage-chat", icon: Brain },
      { label: "Loop Theater", href: "/workbench/loop-theater", icon: Play },
      { label: "Governance", href: "/workbench/governance", icon: ShieldCheck },
      { label: "Code Review", href: "/workbench/code-review", icon: ClipboardCheck },
      { label: "Milestones", href: "/workbench/milestones", icon: Route },
      { label: "Artifacts", href: "/workbench/artifacts", icon: ScrollText },
      { label: "Audit", href: "/workbench/audit", icon: FileText },
      { label: "Export", href: "/workbench/export", icon: Package },
    ],
  },
  {
    label: "Code Generation",
    description: "Repos to patches and verification",
    items: [
      { label: "Run Cockpit", href: "/foundry", icon: Hammer },
      { label: "Repositories", href: "/foundry/repos", icon: GitBranch },
      { label: "Generation Runs", href: "/foundry/runs", icon: Play },
      { label: "Run History", href: "/foundry/history", icon: Activity },
      { label: "Generated Files", href: "/foundry/artifacts", icon: Package },
      { label: "Gaps to Fix", href: "/foundry/gaps", icon: ShieldCheck },
      { label: "Patch Tasks", href: "/foundry/llm-tasks", icon: Cpu },
      { label: "Change Plans", href: "/foundry/change-plans", icon: Route },
      { label: "Verify Output", href: "/foundry/verification", icon: ClipboardCheck },
      { label: "Receipts", href: "/foundry/receipts", icon: FileText },
    ],
  },
  {
    label: "Identity and Access",
    description: "Users, teams, roles, and capability access",
    items: [
      { label: "Identity Dashboard", href: "/identity/dashboard", icon: LayoutDashboard },
      { label: "Users", href: "/identity/users", icon: Users },
      { label: "Teams", href: "/identity/teams", icon: Network },
      { label: "Business Units", href: "/identity/business-units", icon: Layers },
      { label: "Roles", href: "/identity/roles", icon: ShieldCheck },
      { label: "Permissions", href: "/identity/permissions", icon: ShieldCheck },
      { label: "Capabilities", href: "/identity/capabilities", icon: GitBranch },
      { label: "Capability Graph", href: "/identity/capability-graph", icon: Route },
      { label: "Variables", href: "/identity/variables", icon: Globe },
      { label: "Authz Check", href: "/identity/authz-check", icon: ClipboardCheck },
      { label: "Sharing Grants", href: "/identity/sharing-grants", icon: Link2 },
      { label: "Identity Audit", href: "/identity/audit", icon: FileText },
    ],
  },
  {
    label: "Governance and FinOps",
    description: "Policies, evidence, model routing, and cost",
    items: [
      { label: "Engine", href: "/engine", icon: Zap },
      { label: "LLM Routing", href: "/llm-settings", icon: Cpu },
      { label: "Audit", href: "/audit", icon: ShieldCheck },
      { label: "Eval Curation", href: "/audit/curation", icon: ClipboardCheck },
      { label: "Cost", href: "/cost", icon: DollarSign },
    ],
  },
];

const allMenuItems = menuSections.flatMap((section) => section.items);

function NavItem({
  label, href, icon: Icon, active, collapsed,
}: ItemDef & { active: boolean; collapsed: boolean }) {
  return (
    <Link href={href} className="block" aria-current={active ? "page" : undefined}>
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

  const matchesHref = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  const activeHref = allMenuItems
    .filter((item) => matchesHref(item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const isActive = (href: string) => href === activeHref;
  const canvasRoute = path.startsWith("/prompt-workbench");
  const effectiveCollapsed = collapsed || canvasRoute || narrowViewport;

  const sidebarWidth = effectiveCollapsed ? 64 : 246;

  function renderSection(section: NavSection, index: number) {
    return !effectiveCollapsed ? (
      <section key={section.label} style={{ marginTop: index === 0 ? 0 : 16 }}>
        <div style={{ padding: "0 12px", marginBottom: 6 }}>
          <p className="label-xs" style={{ marginBottom: 2 }}>{section.label}</p>
          <p
            style={{
              margin: 0,
              color: "var(--color-outline)",
              fontSize: "0.625rem",
              lineHeight: 1.25,
              fontWeight: 600,
            }}
          >
            {section.description}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {section.items.map(item => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={false} />
          ))}
        </div>
      </section>
    ) : (
      <section
        key={section.label}
        title={section.label}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          marginTop: index === 0 ? 0 : 8,
          paddingTop: index === 0 ? 0 : 8,
          borderTop: index === 0 ? "none" : "1px solid rgba(106,116,134,0.22)",
        }}
      >
        {section.items.map(item => (
          <NavItem key={item.href} {...item} active={isActive(item.href)} collapsed={true} />
        ))}
      </section>
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
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(54,135,39,0.10)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--color-surface-container)"; }}
        >
          {effectiveCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* ── Navigation ── */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "12px 8px" }}>

        {menuSections.map(renderSection)}
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
