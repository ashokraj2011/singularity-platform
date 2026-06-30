/**
 * Shared route-metadata registry — the single source of truth for navigation.
 *
 * Before this, the sidebar, app switcher, help page, and (future) command palette
 * + breadcrumbs each hardcoded their own route lists, which drifted. This module
 * is the one place routes are declared; every nav surface derives from it.
 *
 * `sidebarSections()` reproduces the previous hardcoded sidebar 1:1 (same groups,
 * order, and icons) so adopting the registry is behavior-preserving. `advanced`
 * and `keywords` are reserved for the upcoming sidebar-collapse + command-palette
 * work and are currently informational only.
 */
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, Wrench, Play, Users, GitBranch, Layers, ScrollText,
  ShieldCheck, Activity, Brain, DollarSign, Cpu, WandSparkles, Bot, Inbox,
  Network, Route, Workflow, Zap, Database, FileText, Globe, Link2, Package,
  Puzzle, ClipboardCheck, BookOpen,
} from "lucide-react";

export type NavGroup =
  | "Start Here"
  | "Operations Center"
  | "Agent Studio"
  | "Prompts and Knowledge"
  | "Workflow Operations"
  | "Workflow Authoring"
  | "Identity and Access"
  | "Governance and FinOps";

export type RouteMeta = {
  id: string;
  label: string;
  href: string;
  group: NavGroup;
  icon: LucideIcon;
  /** Short description for help/breadcrumbs/palette subtitles. */
  description?: string;
  /** Reserved: demote behind an "Advanced" disclosure in the collapsed sidebar. */
  advanced?: boolean;
  /** Reserved: extra search terms for the command palette. */
  keywords?: string[];
};

/** Group order + description (drives sidebar section headers). */
export const NAV_GROUPS: { label: NavGroup; description: string }[] = [
  { label: "Start Here", description: "Overview and app catalog" },
  { label: "Operations Center", description: "Health, topology, setup, and trust" },
  { label: "Agent Studio", description: "Create, govern, and run agents" },
  { label: "Prompts and Knowledge", description: "Behavior, prompts, learning, and memory" },
  { label: "Workflow Operations", description: "Plan, route, start, and monitor work" },
  { label: "Workflow Authoring", description: "Design workflow assets and integrations" },
  { label: "Identity and Access", description: "Users, teams, roles, and capability access" },
  { label: "Governance and FinOps", description: "Policies, evidence, model routing, and cost" },
];

/** Every nav-visible route, in display order within its group. */
export const ROUTES: RouteMeta[] = [
  // Start Here
  { id: "start", label: "Start SDLC Work", href: "/start", group: "Start Here", icon: Play },
  { id: "home", label: "Command Center", href: "/", group: "Start Here", icon: LayoutDashboard },
  { id: "control-plane", label: "App Catalog", href: "/control-plane", group: "Start Here", icon: Network },
  { id: "help", label: "User Guide", href: "/help", group: "Start Here", icon: BookOpen },

  // Operations Center
  { id: "ops-readiness", label: "Readiness", href: "/operations/readiness", group: "Operations Center", icon: Activity },
  { id: "ops-architecture", label: "Live App Map", href: "/operations/architecture", group: "Operations Center", icon: Network },
  { id: "ops-access-keys", label: "Access Keys", href: "/operations/access-keys", group: "Operations Center", icon: ShieldCheck },
  { id: "ops-setup", label: "Setup Center", href: "/operations/setup", group: "Operations Center", icon: Wrench },
  { id: "ops-trust", label: "Trust Evidence", href: "/operations/trust", group: "Operations Center", icon: ClipboardCheck },

  // Agent Studio
  { id: "agents", label: "Agents", href: "/agents/studio", group: "Agent Studio", icon: Bot },
  { id: "capabilities", label: "Capabilities", href: "/capabilities", group: "Agent Studio", icon: GitBranch },
  { id: "tools", label: "Tools", href: "/tools", group: "Agent Studio", icon: Wrench },
  { id: "tool-grants", label: "Tool Grants", href: "/tool-grants", group: "Agent Studio", icon: ShieldCheck },
  { id: "executions", label: "Executions", href: "/executions", group: "Agent Studio", icon: Play },

  // Prompts and Knowledge
  { id: "prompt-workbench", label: "Prompt Workbench", href: "/prompt-workbench", group: "Prompts and Knowledge", icon: WandSparkles },
  { id: "prompt-profiles", label: "Behavior Profiles", href: "/prompt-profiles", group: "Prompts and Knowledge", icon: Layers },
  { id: "prompt-layers", label: "Instruction Blocks", href: "/prompt-layers", group: "Prompts and Knowledge", icon: ScrollText },
  { id: "runtime-executions", label: "Runtime Receipts", href: "/runtime-executions", group: "Prompts and Knowledge", icon: Activity },
  { id: "learning", label: "Learning", href: "/learning", group: "Prompts and Knowledge", icon: Brain },
  { id: "memory", label: "Memory", href: "/memory", group: "Prompts and Knowledge", icon: Database },

  // Workflow Operations
  { id: "workflows", label: "Workflow Home", href: "/workflows", group: "Workflow Operations", icon: Workflow },
  { id: "workflows-planner", label: "Story Planner", href: "/workflows/planner", group: "Workflow Operations", icon: Route },
  { id: "workflows-start", label: "Guided Launch", href: "/workflows/start", group: "Workflow Operations", icon: Play },
  { id: "workflows-templates-gallery", label: "Template Gallery", href: "/workflows/templates/gallery", group: "Workflow Operations", icon: GitBranch },
  { id: "workflows-inbox", label: "Inbox", href: "/workflows/inbox", group: "Workflow Operations", icon: Inbox },
  { id: "work-items", label: "Work Hub", href: "/work-items", group: "Workflow Operations", icon: Network },
  { id: "runs", label: "Runs", href: "/runs", group: "Workflow Operations", icon: Activity },
  { id: "workflows-history", label: "Run History", href: "/workflows/history", group: "Workflow Operations", icon: FileText },
  { id: "workflows-runtime", label: "Runtime", href: "/workflows/runtime", group: "Workflow Operations", icon: Zap },

  // Workflow Authoring
  { id: "workflows-templates", label: "Workflow Manager", href: "/workflows/templates", group: "Workflow Authoring", icon: Workflow },
  { id: "workflows-metadata", label: "Metadata", href: "/workflows/metadata", group: "Workflow Authoring", icon: Database },
  { id: "workflows-artifacts", label: "Artifact Studio", href: "/workflows/artifacts", group: "Workflow Authoring", icon: ScrollText },
  { id: "workflows-artifacts-explorer", label: "Artifact Explorer", href: "/workflows/artifacts/explorer", group: "Workflow Authoring", icon: Package },
  { id: "workflows-node-types", label: "Node Types", href: "/workflows/node-types", group: "Workflow Authoring", icon: Puzzle },
  { id: "workflows-connectors", label: "Connectors", href: "/workflows/connectors", group: "Workflow Authoring", icon: Link2 },

  // Identity and Access
  { id: "identity-dashboard", label: "Identity Dashboard", href: "/identity/dashboard", group: "Identity and Access", icon: LayoutDashboard },
  { id: "identity-users", label: "Users", href: "/identity/users", group: "Identity and Access", icon: Users },
  { id: "identity-teams", label: "Teams", href: "/identity/teams", group: "Identity and Access", icon: Network },
  { id: "identity-business-units", label: "Business Units", href: "/identity/business-units", group: "Identity and Access", icon: Layers },
  { id: "identity-roles", label: "Roles", href: "/identity/roles", group: "Identity and Access", icon: ShieldCheck },
  { id: "identity-permissions", label: "Permissions", href: "/identity/permissions", group: "Identity and Access", icon: ShieldCheck },
  { id: "identity-capabilities", label: "Capabilities", href: "/identity/capabilities", group: "Identity and Access", icon: GitBranch },
  { id: "identity-capability-graph", label: "Capability Graph", href: "/identity/capability-graph", group: "Identity and Access", icon: Route },
  { id: "identity-variables", label: "Variables", href: "/identity/variables", group: "Identity and Access", icon: Globe },
  { id: "identity-authz-check", label: "Authz Check", href: "/identity/authz-check", group: "Identity and Access", icon: ClipboardCheck },
  { id: "identity-sharing-grants", label: "Sharing Grants", href: "/identity/sharing-grants", group: "Identity and Access", icon: Link2 },
  { id: "identity-audit", label: "Identity Audit", href: "/identity/audit", group: "Identity and Access", icon: FileText },

  // Governance and FinOps
  { id: "engine", label: "Engine", href: "/engine", group: "Governance and FinOps", icon: Zap },
  { id: "llm-settings", label: "LLM Routing", href: "/llm-settings", group: "Governance and FinOps", icon: Cpu },
  { id: "audit", label: "Audit", href: "/audit", group: "Governance and FinOps", icon: ShieldCheck },
  { id: "audit-curation", label: "Eval Curation", href: "/audit/curation", group: "Governance and FinOps", icon: ClipboardCheck },
  { id: "cost", label: "Cost", href: "/cost", group: "Governance and FinOps", icon: DollarSign },
];

export type SidebarSection = { label: NavGroup; description: string; items: RouteMeta[] };

/** Group ROUTES into ordered sidebar sections (1:1 with the legacy hardcoded list). */
export function sidebarSections(): SidebarSection[] {
  return NAV_GROUPS.map((g) => ({
    label: g.label,
    description: g.description,
    items: ROUTES.filter((r) => r.group === g.label),
  }));
}
