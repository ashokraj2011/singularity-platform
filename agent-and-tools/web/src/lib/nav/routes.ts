/**
 * Shared route-metadata registry: the single source of truth for navigation.
 *
 * Routes are grouped by the SDLC phase in which a user needs them, rather than
 * by the internal service that implements them. The sidebar, command palette,
 * app switcher, and help surfaces all consume this registry.
 */
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, Wrench, Play, Users, GitBranch, Layers, ScrollText,
  ShieldCheck, Activity, Brain, DollarSign, Cpu, WandSparkles, Bot, Inbox,
  Network, Route, Workflow, Zap, Database, FileText, Globe, Link2, Package,
  Puzzle, ClipboardCheck, BookOpen, Settings, Boxes, KeyRound, Lightbulb, Sparkles,
} from "lucide-react";

export type NavGroup =
  | "Home"
  | "Discover"
  | "Define"
  | "Plan"
  | "Execute"
  | "Verify"
  | "Release"
  | "Operate"
  | "Administration";

export type RouteMeta = {
  id: string;
  label: string;
  href: string;
  group: NavGroup;
  icon: LucideIcon;
  /** Short description for help, breadcrumbs, and command palette subtitles. */
  description?: string;
  /** Hide from the default menu until advanced controls are enabled. */
  advanced?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: string[];
  /** Importance within a phase and ranking in the command palette. */
  priority?: "journey" | "primary" | "secondary" | "admin";
  /** Route family for shell and active-item accent styling. */
  surfaceType?: "launch" | "workflow" | "agent" | "operation" | "identity" | "governance" | "knowledge" | "runtime";
  /** Optional concise status label for palette and app surfaces. */
  statusLabel?: string;
  /** Open a product-style workspace in a separate browser tab. */
  openInNewTab?: boolean;
};

export type NavGroupMeta = {
  label: NavGroup;
  description: string;
  /** Number shown in the sidebar for lifecycle phases; Home/Admin are unnumbered. */
  phase?: string;
};

/** Lifecycle order and descriptions used by every navigation surface. */
export const NAV_GROUPS: NavGroupMeta[] = [
  { label: "Home", description: "Start, resume, or learn" },
  { label: "Discover", description: "Ideas, opportunities, and capabilities", phase: "01" },
  { label: "Define", description: "Specifications, agents, prompts, and tools", phase: "02" },
  { label: "Plan", description: "Work, workflows, and routing", phase: "03" },
  { label: "Execute", description: "Launch and monitor governed work", phase: "04" },
  { label: "Verify", description: "Review, reconcile, and prove outcomes", phase: "05" },
  { label: "Release", description: "Package evidence and explain changes", phase: "06" },
  { label: "Operate", description: "Runtime, models, events, cost, and health", phase: "07" },
  { label: "Administration", description: "Identity, access, and platform settings" },
];

/** Every navigation route, ordered within its SDLC phase. */
export const ROUTES: RouteMeta[] = [
  // Home
  { id: "start", label: "Start Governed Work", href: "/start", group: "Home", icon: Play, priority: "journey", surfaceType: "launch", statusLabel: "Start" },
  { id: "home", label: "Command Center", href: "/", group: "Home", icon: LayoutDashboard, priority: "primary", surfaceType: "launch" },
  { id: "help", label: "Platform Guide", href: "/help", group: "Home", icon: BookOpen, priority: "secondary", surfaceType: "launch", description: "Learn Work Items, workflows, events, runtimes, node options, and troubleshooting.", keywords: ["help", "guide", "docs", "work item", "event", "node", "workflow", "runbook"] },

  // 01 Discover
  { id: "synthesis", label: "Synthesis Workspace", href: "/synthesis", group: "Discover", icon: Sparkles, priority: "journey", surfaceType: "workflow", openInNewTab: true, statusLabel: "Workspace", description: "Capture ideas, map journeys, validate assumptions, and converge a specification in a dedicated workspace.", keywords: ["synthesis", "discovery", "ideas", "idea board", "journey map", "diagram", "wiki", "assumption", "spec", "traceability", "use case", "concept", "elicitation"] },
  { id: "capabilities", label: "Capability Portfolio", href: "/capabilities", group: "Discover", icon: GitBranch, priority: "primary", surfaceType: "agent" },
  { id: "learning", label: "Learning Hub", href: "/learning", group: "Discover", icon: Brain, priority: "secondary", surfaceType: "knowledge" },
  { id: "concept-studio", label: "Concept Maps", href: "/concept-studio", group: "Discover", icon: Lightbulb, advanced: true, priority: "secondary", surfaceType: "agent", description: "Open the focused concept-map surface outside the broader Synthesis workspace.", keywords: ["creative studio", "ideas", "concept map", "concept", "proposal"] },

  // 02 Define
  { id: "studio-projects", label: "Specifications", href: "/synthesis/overview", group: "Define", icon: Layers, priority: "journey", surfaceType: "workflow", description: "Shape requirements, designs, assumptions, and the contract that governs generated Work Items.", keywords: ["synthesis", "project", "specification", "requirements", "design", "board", "rooms", "work items", "workspace"] },
  { id: "agents", label: "Agent Studio", href: "/agents/studio", group: "Define", icon: Bot, priority: "primary", surfaceType: "agent" },
  { id: "tools", label: "Tool Registry", href: "/tools", group: "Define", icon: Boxes, priority: "primary", surfaceType: "agent" },
  { id: "prompt-workbench", label: "Prompt Workbench", href: "/prompt-workbench", group: "Define", icon: WandSparkles, priority: "primary", surfaceType: "knowledge" },
  { id: "prompt-profiles", label: "Behavior Profiles", href: "/prompt-profiles", group: "Define", icon: Layers, priority: "secondary", surfaceType: "knowledge" },
  { id: "memory", label: "Memory", href: "/memory", group: "Define", icon: Database, priority: "secondary", surfaceType: "knowledge" },
  { id: "prompt-layers", label: "Instruction Blocks", href: "/prompt-layers", group: "Define", icon: ScrollText, advanced: true, priority: "admin", surfaceType: "knowledge" },

  // 03 Plan
  { id: "workflows-planner", label: "Work Planner", href: "/workflows/planner", group: "Plan", icon: Route, priority: "journey", surfaceType: "workflow", description: "Turn a request, story, or desired outcome into scoped Work Items." },
  { id: "work-items", label: "Work Items", href: "/work-items", group: "Plan", icon: Network, priority: "primary", surfaceType: "workflow" },
  { id: "workflows", label: "Workflow Center", href: "/workflows", group: "Plan", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-templates", label: "Workflow Designer", href: "/workflows/templates", group: "Plan", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-templates-gallery", label: "Template Gallery", href: "/workflows/templates/gallery", group: "Plan", icon: GitBranch, advanced: true, priority: "secondary", surfaceType: "workflow" },
  { id: "workflows-routing-policies", label: "Routing Policies", href: "/workflows/routing-policies", group: "Plan", icon: Route, advanced: true, priority: "admin", surfaceType: "workflow", description: "Route WorkItems to workflow templates and diagnose stale bindings.", keywords: ["routing", "workitem", "policy", "template", "diagnostics"] },
  { id: "workflows-metadata", label: "Workflow Metadata", href: "/workflows/metadata", group: "Plan", icon: Database, advanced: true, priority: "admin", surfaceType: "workflow" },
  { id: "workflows-node-types", label: "Node Types", href: "/workflows/node-types", group: "Plan", icon: Puzzle, advanced: true, priority: "admin", surfaceType: "workflow" },

  // 04 Execute
  { id: "workflows-start", label: "Workflow Launch", href: "/workflows/start", group: "Execute", icon: Play, priority: "journey", surfaceType: "workflow" },
  { id: "runs", label: "Workflow Runs", href: "/runs", group: "Execute", icon: Activity, priority: "journey", surfaceType: "workflow" },
  { id: "executions", label: "Agent Executions", href: "/executions", group: "Execute", icon: Play, advanced: true, priority: "admin", surfaceType: "agent" },

  // 05 Verify
  { id: "workflows-inbox", label: "Review Inbox", href: "/workflows/inbox", group: "Verify", icon: Inbox, priority: "journey", surfaceType: "workflow" },
  { id: "workflows-reconciliation", label: "Reconciliation", href: "/workflows/reconciliation", group: "Verify", icon: ClipboardCheck, priority: "primary", surfaceType: "workflow", description: "Review submissions and reconciliation verdicts across Work Items.", keywords: ["reconciliation", "submission", "verdict", "spec", "review"] },
  { id: "engine", label: "Evaluation Engine", href: "/engine", group: "Verify", icon: Zap, priority: "primary", surfaceType: "governance" },
  { id: "ops-trust", label: "Trust Evidence", href: "/operations/trust", group: "Verify", icon: ClipboardCheck, priority: "primary", surfaceType: "operation" },
  { id: "audit", label: "Audit & Logs", href: "/audit", group: "Verify", icon: ShieldCheck, priority: "secondary", surfaceType: "governance", description: "Review governance events, approvals, traces, and raw platform logs.", keywords: ["audit", "logs", "approvals", "trace", "splunk", "datadog"] },
  { id: "audit-curation", label: "Evaluation Curation", href: "/audit/curation", group: "Verify", icon: ClipboardCheck, advanced: true, priority: "admin", surfaceType: "governance" },

  // 06 Release
  { id: "workflows-artifacts", label: "Delivery Artifacts", href: "/workflows/artifacts", group: "Release", icon: ScrollText, priority: "journey", surfaceType: "workflow" },
  { id: "ops-git-history", label: "Git Change Explainer", href: "/operations/git-history", group: "Release", icon: GitBranch, priority: "primary", surfaceType: "operation", description: "Explain code changes between dates from Git history.", keywords: ["git", "history", "release", "evidence", "changelog", "diff"] },
  { id: "workflows-history", label: "Run History", href: "/workflows/history", group: "Release", icon: FileText, advanced: true, priority: "secondary", surfaceType: "workflow" },
  { id: "workflows-artifacts-explorer", label: "Artifact Explorer", href: "/workflows/artifacts/explorer", group: "Release", icon: Package, advanced: true, priority: "admin", surfaceType: "workflow" },

  // 07 Operate
  { id: "ops-readiness", label: "Platform Readiness", href: "/operations/readiness", group: "Operate", icon: Activity, priority: "journey", surfaceType: "operation" },
  { id: "ops-architecture", label: "System Map", href: "/operations/architecture", group: "Operate", icon: Network, priority: "primary", surfaceType: "operation" },
  { id: "workflows-control-plane", label: "Workflow Operations", href: "/workflows/control-plane", group: "Operate", icon: Cpu, priority: "primary", surfaceType: "workflow", description: "Operate event intake, routing, deliveries, LLM aliases, webhooks, and runner queues.", keywords: ["llm", "eventbus", "webhook", "trigger", "pending execution", "runner", "direct llm", "control plane"] },
  { id: "llm-settings", label: "Runtime & Models", href: "/llm-settings", group: "Operate", icon: Cpu, priority: "primary", surfaceType: "runtime" },
  { id: "cost", label: "Cost & Usage", href: "/cost", group: "Operate", icon: DollarSign, priority: "secondary", surfaceType: "governance" },
  { id: "ops-setup", label: "Setup Center", href: "/operations/setup", group: "Operate", icon: Wrench, priority: "secondary", surfaceType: "operation" },
  { id: "control-plane", label: "Platform Services", href: "/control-plane", group: "Operate", icon: Network, advanced: true, priority: "secondary", surfaceType: "operation" },
  { id: "runtime-executions", label: "Runtime Receipts", href: "/runtime-executions", group: "Operate", icon: Activity, advanced: true, priority: "admin", surfaceType: "runtime" },
  { id: "workflows-runtime", label: "Workflow Runtime", href: "/workflows/runtime", group: "Operate", icon: Zap, advanced: true, priority: "admin", surfaceType: "workflow" },
  { id: "workflows-connectors", label: "Connectors", href: "/workflows/connectors", group: "Operate", icon: Link2, advanced: true, priority: "admin", surfaceType: "workflow" },

  // Administration
  { id: "settings", label: "Platform Settings", href: "/settings", group: "Administration", icon: Settings, priority: "primary", surfaceType: "governance", description: "Runtime, source, notifications, workflow defaults, and security settings.", keywords: ["settings", "notifications", "runtime", "llm", "git", "security"] },
  { id: "identity-dashboard", label: "Identity & Access", href: "/identity/dashboard", group: "Administration", icon: LayoutDashboard, priority: "primary", surfaceType: "identity" },
  { id: "identity-users", label: "Users", href: "/identity/users", group: "Administration", icon: Users, priority: "primary", surfaceType: "identity" },
  { id: "identity-teams", label: "Teams", href: "/identity/teams", group: "Administration", icon: Network, priority: "primary", surfaceType: "identity" },
  { id: "identity-roles", label: "Roles", href: "/identity/roles", group: "Administration", icon: ShieldCheck, priority: "primary", surfaceType: "identity" },
  { id: "identity-capabilities", label: "Capability Governance", href: "/identity/capabilities", group: "Administration", icon: GitBranch, priority: "secondary", surfaceType: "identity" },
  { id: "identity-effective-access", label: "Effective Access", href: "/identity/effective-access", group: "Administration", icon: ShieldCheck, priority: "secondary", surfaceType: "identity", description: "See permissions effective for the current tenant and session." },
  { id: "ops-access-keys", label: "Service Access Keys", href: "/operations/access-keys", group: "Administration", icon: KeyRound, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-permissions", label: "Permission Catalog", href: "/identity/permissions", group: "Administration", icon: ShieldCheck, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-audit", label: "Identity Audit", href: "/identity/audit", group: "Administration", icon: FileText, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "tool-grants", label: "Tool Grants", href: "/tool-grants", group: "Administration", icon: KeyRound, advanced: true, priority: "admin", surfaceType: "agent" },
  { id: "identity-mcp-servers", label: "MCP Registry", href: "/identity/mcp-servers", group: "Administration", icon: Network, advanced: true, priority: "admin", surfaceType: "identity", description: "Register MCP tool servers available to each capability.", keywords: ["mcp", "server", "tool", "registry", "capability"] },
  { id: "identity-business-units", label: "Business Units", href: "/identity/business-units", group: "Administration", icon: Layers, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-capability-graph", label: "Capability Graph", href: "/identity/capability-graph", group: "Administration", icon: Route, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-variables", label: "Runtime Variables", href: "/identity/variables", group: "Administration", icon: Globe, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-authz-check", label: "Policy Tester", href: "/identity/authz-check", group: "Administration", icon: ClipboardCheck, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-sharing-grants", label: "Resource Sharing", href: "/identity/sharing-grants", group: "Administration", icon: Link2, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-git-connections", label: "Git Connections", href: "/identity/git-connections", group: "Administration", icon: GitBranch, advanced: true, priority: "admin", surfaceType: "identity", description: "Per-tenant GitHub App installations for the Git credential broker.", keywords: ["git", "github", "app", "credential", "broker", "token"] },
  { id: "identity-repository-grants", label: "Repository Grants", href: "/identity/repository-grants", group: "Administration", icon: ShieldCheck, advanced: true, priority: "admin", surfaceType: "identity", description: "Authorize subjects to run Git operations on repositories through the broker.", keywords: ["git", "repo", "grant", "push", "clone", "credential", "broker"] },
];

export type SidebarSection = NavGroupMeta & { items: RouteMeta[] };

/** Group routes into ordered lifecycle sections. */
export function sidebarSections(): SidebarSection[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: ROUTES.filter((route) => route.group === group.label),
  }));
}

export function advancedRoutes(): RouteMeta[] {
  return ROUTES.filter((route) => route.advanced);
}

export function journeyRoutes(): RouteMeta[] {
  return ROUTES.filter((route) => route.priority === "journey");
}
