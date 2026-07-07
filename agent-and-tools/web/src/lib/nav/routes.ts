/**
 * Shared route-metadata registry — the single source of truth for navigation.
 *
 * Before this, the sidebar, app switcher, help page, and command palette each
 * hardcoded their own route lists, which drifted. This module is the one place
 * routes are declared; every nav surface derives from it.
 *
 * `advanced: true` demotes a route out of the default sidebar groups into a
 * collapsible "Advanced" section (it stays fully reachable via the command
 * palette and direct URL). `sidebarSections()` returns groups in display order;
 * the sidebar splits each into primary vs advanced.
 */
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, Wrench, Play, Users, GitBranch, Layers, ScrollText,
  ShieldCheck, Activity, Brain, DollarSign, Cpu, WandSparkles, Bot, Inbox,
  Network, Route, Workflow, Zap, Database, FileText, Globe, Link2, Package,
  Puzzle, ClipboardCheck, BookOpen, Settings, Boxes, KeyRound,
} from "lucide-react";

export type NavGroup =
  | "Start Here"
  | "Operations Center"
  | "Agent Studio"
  | "Prompts and Knowledge"
  | "Workflows"
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
  /** Demote behind the sidebar's "Advanced" disclosure (still in the palette). */
  advanced?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: string[];
  /** Primary journey routes render above domain drawers in the sidebar. */
  priority?: "journey" | "primary" | "secondary" | "admin";
  /** Route family for shell/app switcher styling. */
  surfaceType?: "launch" | "workflow" | "agent" | "operation" | "identity" | "governance" | "knowledge" | "runtime";
  /** Optional concise status/lifecycle label for palette and app surfaces. */
  statusLabel?: string;
};

/** Group order + description (drives sidebar section headers). */
export const NAV_GROUPS: { label: NavGroup; description: string }[] = [
  { label: "Start Here", description: "Overview and app catalog" },
  { label: "Operations Center", description: "Health, topology, setup, and trust" },
  { label: "Agent Studio", description: "Create, govern, and run agents" },
  { label: "Prompts and Knowledge", description: "Behavior, prompts, learning, and memory" },
  { label: "Workflows", description: "Plan, author, launch, and monitor work" },
  { label: "Identity and Access", description: "Users, teams, roles, and capability access" },
  { label: "Governance and FinOps", description: "Policies, evidence, model routing, and cost" },
];

/** Every nav-visible route, in display order within its group. */
export const ROUTES: RouteMeta[] = [
  // Start Here
  { id: "start", label: "Start SDLC Work", href: "/start", group: "Start Here", icon: Play, priority: "journey", surfaceType: "launch", statusLabel: "Start" },
  { id: "home", label: "Command Center", href: "/", group: "Start Here", icon: LayoutDashboard, priority: "primary", surfaceType: "launch" },
  { id: "control-plane", label: "App Catalog", href: "/control-plane", group: "Start Here", icon: Network, priority: "secondary", surfaceType: "operation" },
  { id: "help", label: "User Guide", href: "/help", group: "Start Here", icon: BookOpen, priority: "secondary", surfaceType: "launch" },

  // Operations Center
  { id: "ops-readiness", label: "Readiness", href: "/operations/readiness", group: "Operations Center", icon: Activity, priority: "primary", surfaceType: "operation" },
  { id: "ops-architecture", label: "Live App Map", href: "/operations/architecture", group: "Operations Center", icon: Network, priority: "primary", surfaceType: "operation" },
  { id: "ops-access-keys", label: "Access Keys", href: "/operations/access-keys", group: "Operations Center", icon: ShieldCheck, priority: "secondary", surfaceType: "operation" },
  { id: "ops-setup", label: "Setup Center", href: "/operations/setup", group: "Operations Center", icon: Wrench, priority: "primary", surfaceType: "operation" },
  { id: "ops-trust", label: "Trust Evidence", href: "/operations/trust", group: "Operations Center", icon: ClipboardCheck, priority: "secondary", surfaceType: "operation" },
  { id: "ops-git-history", label: "Git Change Explainer", href: "/operations/git-history", group: "Operations Center", icon: GitBranch, priority: "secondary", surfaceType: "operation", description: "Explain code changes between dates from git history.", keywords: ["git", "history", "release", "evidence", "changelog", "diff"] },

  // Agent Studio
  { id: "agents", label: "Agents", href: "/agents/studio", group: "Agent Studio", icon: Bot, priority: "primary", surfaceType: "agent" },
  { id: "capabilities", label: "Capabilities", href: "/capabilities", group: "Agent Studio", icon: GitBranch, priority: "primary", surfaceType: "agent" },
  { id: "tools", label: "Tools", href: "/tools", group: "Agent Studio", icon: Boxes, priority: "primary", surfaceType: "agent" },
  { id: "tool-grants", label: "Tool Grants", href: "/tool-grants", group: "Agent Studio", icon: KeyRound, advanced: true, priority: "admin", surfaceType: "agent" },
  { id: "executions", label: "Executions", href: "/executions", group: "Agent Studio", icon: Play, advanced: true, priority: "admin", surfaceType: "agent" },

  // Prompts and Knowledge
  { id: "prompt-workbench", label: "Prompt Workbench", href: "/prompt-workbench", group: "Prompts and Knowledge", icon: WandSparkles, priority: "primary", surfaceType: "knowledge" },
  { id: "prompt-profiles", label: "Behavior Profiles", href: "/prompt-profiles", group: "Prompts and Knowledge", icon: Layers, priority: "secondary", surfaceType: "knowledge" },
  { id: "prompt-layers", label: "Instruction Blocks", href: "/prompt-layers", group: "Prompts and Knowledge", icon: ScrollText, advanced: true, priority: "admin", surfaceType: "knowledge" },
  { id: "runtime-executions", label: "Runtime Receipts", href: "/runtime-executions", group: "Prompts and Knowledge", icon: Activity, advanced: true, priority: "admin", surfaceType: "knowledge" },
  { id: "learning", label: "Learning", href: "/learning", group: "Prompts and Knowledge", icon: Brain, priority: "secondary", surfaceType: "knowledge" },
  { id: "memory", label: "Memory", href: "/memory", group: "Prompts and Knowledge", icon: Database, priority: "secondary", surfaceType: "knowledge" },

  // Workflows (merged: operations + authoring)
  { id: "workflows", label: "Workflow Home", href: "/workflows", group: "Workflows", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-planner", label: "Story Planner", href: "/workflows/planner", group: "Workflows", icon: Route, priority: "journey", surfaceType: "workflow", statusLabel: "Plan" },
  { id: "workflows-start", label: "Guided Launch", href: "/workflows/start", group: "Workflows", icon: Play, priority: "journey", surfaceType: "workflow", statusLabel: "Launch" },
  { id: "workflows-inbox", label: "Inbox", href: "/workflows/inbox", group: "Workflows", icon: Inbox, priority: "secondary", surfaceType: "workflow" },
  { id: "runs", label: "Runs", href: "/runs", group: "Workflows", icon: Activity, priority: "journey", surfaceType: "workflow", statusLabel: "Run" },
  { id: "workflows-templates", label: "Workflow Manager", href: "/workflows/templates", group: "Workflows", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-artifacts", label: "Artifact Studio", href: "/workflows/artifacts", group: "Workflows", icon: ScrollText, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-templates-gallery", label: "Template Gallery", href: "/workflows/templates/gallery", group: "Workflows", icon: GitBranch, advanced: true },
  { id: "work-items", label: "Work Items", href: "/work-items", group: "Workflows", icon: Network, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-history", label: "Run History", href: "/workflows/history", group: "Workflows", icon: FileText, advanced: true },
  { id: "workflows-runtime", label: "Runtime", href: "/workflows/runtime", group: "Workflows", icon: Zap, advanced: true },
  { id: "workflows-routing-policies", label: "Routing Policies", href: "/workflows/routing-policies", group: "Workflows", icon: Route, advanced: true, description: "Diagnose WorkItem routing rules and stale workflow-template bindings.", keywords: ["routing", "workitem", "policy", "template", "diagnostics"] },
  { id: "workflows-metadata", label: "Metadata", href: "/workflows/metadata", group: "Workflows", icon: Database, advanced: true },
  { id: "workflows-artifacts-explorer", label: "Artifact Explorer", href: "/workflows/artifacts/explorer", group: "Workflows", icon: Package, advanced: true },
  { id: "workflows-node-types", label: "Node Types", href: "/workflows/node-types", group: "Workflows", icon: Puzzle, advanced: true },
  { id: "workflows-connectors", label: "Connectors", href: "/workflows/connectors", group: "Workflows", icon: Link2, advanced: true },

  // Identity and Access
  { id: "identity-dashboard", label: "Identity Dashboard", href: "/identity/dashboard", group: "Identity and Access", icon: LayoutDashboard, priority: "primary", surfaceType: "identity" },
  { id: "identity-users", label: "Users", href: "/identity/users", group: "Identity and Access", icon: Users, priority: "primary", surfaceType: "identity" },
  { id: "identity-teams", label: "Teams", href: "/identity/teams", group: "Identity and Access", icon: Network, priority: "primary", surfaceType: "identity" },
  { id: "identity-roles", label: "Roles", href: "/identity/roles", group: "Identity and Access", icon: ShieldCheck, priority: "primary", surfaceType: "identity" },
  { id: "identity-permissions", label: "Permissions", href: "/identity/permissions", group: "Identity and Access", icon: ShieldCheck, priority: "secondary", surfaceType: "identity" },
  { id: "identity-capabilities", label: "Capabilities", href: "/identity/capabilities", group: "Identity and Access", icon: GitBranch, priority: "secondary", surfaceType: "identity" },
  { id: "identity-mcp-servers", label: "MCP Servers", href: "/identity/mcp-servers", group: "Identity and Access", icon: Network, advanced: true, description: "Register the MCP tool servers available to each capability.", keywords: ["mcp", "server", "tool", "registry", "capability"] },
  { id: "identity-audit", label: "Identity Audit", href: "/identity/audit", group: "Identity and Access", icon: FileText, priority: "secondary", surfaceType: "identity" },
  { id: "identity-business-units", label: "Business Units", href: "/identity/business-units", group: "Identity and Access", icon: Layers, advanced: true },
  { id: "identity-capability-graph", label: "Capability Graph", href: "/identity/capability-graph", group: "Identity and Access", icon: Route, advanced: true },
  { id: "identity-variables", label: "Variables", href: "/identity/variables", group: "Identity and Access", icon: Globe, advanced: true },
  { id: "identity-authz-check", label: "Authz Check", href: "/identity/authz-check", group: "Identity and Access", icon: ClipboardCheck, advanced: true },
  { id: "identity-sharing-grants", label: "Sharing Grants", href: "/identity/sharing-grants", group: "Identity and Access", icon: Link2, advanced: true },
  { id: "identity-git-connections", label: "GitHub Connections", href: "/identity/git-connections", group: "Identity and Access", icon: GitBranch, advanced: true, description: "Per-tenant GitHub App installations for the git credential broker.", keywords: ["git", "github", "app", "credential", "broker", "token"] },
  { id: "identity-repository-grants", label: "Repository Grants", href: "/identity/repository-grants", group: "Identity and Access", icon: ShieldCheck, advanced: true, description: "Authorize subjects to run git operations on repositories via the broker.", keywords: ["git", "repo", "grant", "push", "clone", "credential", "broker"] },

  // Governance and FinOps
  { id: "engine", label: "Engine", href: "/engine", group: "Governance and FinOps", icon: Zap, priority: "primary", surfaceType: "governance" },
  { id: "llm-settings", label: "Runtime + LLM", href: "/llm-settings", group: "Governance and FinOps", icon: Cpu, priority: "journey", surfaceType: "runtime", statusLabel: "Runtime" },
  { id: "settings", label: "Platform Settings", href: "/settings", group: "Governance and FinOps", icon: Settings, priority: "secondary", surfaceType: "governance", statusLabel: "Settings", description: "Runtime, source, notifications, workflow defaults, and security settings.", keywords: ["settings", "notifications", "runtime", "llm", "git", "security"] },
  { id: "audit", label: "Audit", href: "/audit", group: "Governance and FinOps", icon: ShieldCheck, priority: "primary", surfaceType: "governance" },
  { id: "cost", label: "Cost", href: "/cost", group: "Governance and FinOps", icon: DollarSign, priority: "primary", surfaceType: "governance" },
  { id: "audit-curation", label: "Eval Curation", href: "/audit/curation", group: "Governance and FinOps", icon: ClipboardCheck, advanced: true, priority: "admin", surfaceType: "governance" },
];

export type SidebarSection = { label: NavGroup; description: string; items: RouteMeta[] };

/** Group ROUTES into ordered sidebar sections (all items; sidebar splits primary vs advanced). */
export function sidebarSections(): SidebarSection[] {
  return NAV_GROUPS.map((g) => ({
    label: g.label,
    description: g.description,
    items: ROUTES.filter((r) => r.group === g.label),
  }));
}

/** Routes demoted behind the sidebar's "Advanced" disclosure (still in the palette). */
export function advancedRoutes(): RouteMeta[] {
  return ROUTES.filter((r) => r.advanced);
}

export function journeyRoutes(): RouteMeta[] {
  return ROUTES.filter((r) => r.priority === "journey");
}
