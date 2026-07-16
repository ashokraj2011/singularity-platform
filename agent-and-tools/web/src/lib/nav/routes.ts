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
  | "SDLC Home"
  | "Discover"
  | "Define"
  | "Plan"
  | "Build"
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
};

export type NavGroupMeta = {
  label: NavGroup;
  description: string;
  /** Number shown in the sidebar for lifecycle phases; Home/Admin are unnumbered. */
  phase?: string;
};

/** Lifecycle order and descriptions used by every navigation surface. */
export const NAV_GROUPS: NavGroupMeta[] = [
  { label: "SDLC Home", description: "Start or resume delivery" },
  { label: "Discover", description: "Ideas, opportunities, and learning", phase: "01" },
  { label: "Define", description: "Specifications, agents, and prompts", phase: "02" },
  { label: "Plan", description: "Stories, work items, and workflow design", phase: "03" },
  { label: "Build", description: "Launch work and run governed agents", phase: "04" },
  { label: "Verify", description: "Review, reconcile, and prove outcomes", phase: "05" },
  { label: "Release", description: "Package evidence and explain changes", phase: "06" },
  { label: "Operate", description: "Runtime, events, health, and topology", phase: "07" },
  { label: "Administration", description: "Identity, access, and platform settings" },
];

/** Every navigation route, ordered within its SDLC phase. */
export const ROUTES: RouteMeta[] = [
  // SDLC Home
  { id: "start", label: "Start SDLC Work", href: "/start", group: "SDLC Home", icon: Play, priority: "journey", surfaceType: "launch", statusLabel: "Start" },
  { id: "home", label: "Command Center", href: "/", group: "SDLC Home", icon: LayoutDashboard, priority: "primary", surfaceType: "launch" },

  // 01 Discover
  { id: "synthesis", label: "Synthesis", href: "/synthesis", group: "Discover", icon: Sparkles, priority: "journey", surfaceType: "workflow", description: "Capture ideas, reduce unknowns, validate assumptions, converge a specification, and generate work.", keywords: ["synthesis", "discovery", "ideas", "idea board", "assumption", "spec", "traceability", "use case", "concept", "elicitation"] },
  { id: "concept-studio", label: "Concept Studio", href: "/concept-studio", group: "Discover", icon: Lightbulb, priority: "primary", surfaceType: "agent", description: "Create, explore, and review concepts in a human-guided idea map.", keywords: ["creative studio", "ideas", "concept map", "concept", "proposal"] },
  { id: "capabilities", label: "Capability Portfolio", href: "/capabilities", group: "Discover", icon: GitBranch, priority: "primary", surfaceType: "agent" },
  { id: "learning", label: "Learning", href: "/learning", group: "Discover", icon: Brain, priority: "secondary", surfaceType: "knowledge" },

  // 02 Define
  { id: "studio-projects", label: "Specification Projects", href: "/studio", group: "Define", icon: Layers, priority: "journey", surfaceType: "workflow", description: "Shape requirements, designs, assumptions, and the specification package that governs generated Work Items.", keywords: ["studio", "project", "specification", "requirements", "design", "board", "rooms", "work items", "workspace"] },
  { id: "agents", label: "Agent Studio", href: "/agents/studio", group: "Define", icon: Bot, priority: "primary", surfaceType: "agent" },
  { id: "prompt-workbench", label: "Prompt Workbench", href: "/prompt-workbench", group: "Define", icon: WandSparkles, priority: "primary", surfaceType: "knowledge" },
  { id: "prompt-profiles", label: "Behavior Profiles", href: "/prompt-profiles", group: "Define", icon: Layers, priority: "secondary", surfaceType: "knowledge" },
  { id: "memory", label: "Memory", href: "/memory", group: "Define", icon: Database, priority: "secondary", surfaceType: "knowledge" },
  { id: "prompt-layers", label: "Instruction Blocks", href: "/prompt-layers", group: "Define", icon: ScrollText, advanced: true, priority: "admin", surfaceType: "knowledge" },

  // 03 Plan
  { id: "workflows-planner", label: "Story Planner", href: "/workflows/planner", group: "Plan", icon: Route, priority: "journey", surfaceType: "workflow" },
  { id: "work-items", label: "Work Items", href: "/work-items", group: "Plan", icon: Network, priority: "primary", surfaceType: "workflow" },
  { id: "workflows", label: "Workflow Home", href: "/workflows", group: "Plan", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-templates", label: "Workflow Designer", href: "/workflows/templates", group: "Plan", icon: Workflow, priority: "primary", surfaceType: "workflow" },
  { id: "workflows-templates-gallery", label: "Template Gallery", href: "/workflows/templates/gallery", group: "Plan", icon: GitBranch, advanced: true, priority: "secondary", surfaceType: "workflow" },
  { id: "workflows-routing-policies", label: "Routing Policies", href: "/workflows/routing-policies", group: "Plan", icon: Route, advanced: true, priority: "admin", surfaceType: "workflow", description: "Route WorkItems to workflow templates and diagnose stale bindings.", keywords: ["routing", "workitem", "policy", "template", "diagnostics"] },
  { id: "workflows-metadata", label: "Workflow Metadata", href: "/workflows/metadata", group: "Plan", icon: Database, advanced: true, priority: "admin", surfaceType: "workflow" },
  { id: "workflows-node-types", label: "Node Types", href: "/workflows/node-types", group: "Plan", icon: Puzzle, advanced: true, priority: "admin", surfaceType: "workflow" },

  // 04 Build
  { id: "workflows-start", label: "Guided Launch", href: "/workflows/start", group: "Build", icon: Play, priority: "journey", surfaceType: "workflow" },
  { id: "runs", label: "Active Runs", href: "/runs", group: "Build", icon: Activity, priority: "journey", surfaceType: "workflow" },
  { id: "tools", label: "Tool Registry", href: "/tools", group: "Build", icon: Boxes, priority: "primary", surfaceType: "agent" },
  { id: "executions", label: "Agent Executions", href: "/executions", group: "Build", icon: Play, advanced: true, priority: "admin", surfaceType: "agent" },

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
  { id: "cost", label: "Cost & Usage", href: "/cost", group: "Release", icon: DollarSign, priority: "secondary", surfaceType: "governance" },
  { id: "workflows-history", label: "Run History", href: "/workflows/history", group: "Release", icon: FileText, advanced: true, priority: "secondary", surfaceType: "workflow" },
  { id: "workflows-artifacts-explorer", label: "Artifact Explorer", href: "/workflows/artifacts/explorer", group: "Release", icon: Package, advanced: true, priority: "admin", surfaceType: "workflow" },

  // 07 Operate
  { id: "ops-readiness", label: "Platform Readiness", href: "/operations/readiness", group: "Operate", icon: Activity, priority: "journey", surfaceType: "operation" },
  { id: "ops-architecture", label: "Live App Map", href: "/operations/architecture", group: "Operate", icon: Network, priority: "primary", surfaceType: "operation" },
  { id: "workflows-control-plane", label: "Workflow Control Plane", href: "/workflows/control-plane", group: "Operate", icon: Cpu, priority: "primary", surfaceType: "workflow", description: "Operate LLM aliases, event intake, webhooks, event-bus subscribers, and runner queues.", keywords: ["llm", "eventbus", "webhook", "trigger", "pending execution", "runner", "direct llm"] },
  { id: "llm-settings", label: "Runtime + LLM", href: "/llm-settings", group: "Operate", icon: Cpu, priority: "primary", surfaceType: "runtime" },
  { id: "ops-setup", label: "Setup Center", href: "/operations/setup", group: "Operate", icon: Wrench, priority: "secondary", surfaceType: "operation" },
  { id: "control-plane", label: "App Catalog", href: "/control-plane", group: "Operate", icon: Network, priority: "secondary", surfaceType: "operation" },
  { id: "runtime-executions", label: "Runtime Receipts", href: "/runtime-executions", group: "Operate", icon: Activity, advanced: true, priority: "admin", surfaceType: "runtime" },
  { id: "workflows-runtime", label: "Workflow Runtime", href: "/workflows/runtime", group: "Operate", icon: Zap, advanced: true, priority: "admin", surfaceType: "workflow" },
  { id: "workflows-connectors", label: "Connectors", href: "/workflows/connectors", group: "Operate", icon: Link2, advanced: true, priority: "admin", surfaceType: "workflow" },

  // Administration
  { id: "settings", label: "Platform Settings", href: "/settings", group: "Administration", icon: Settings, priority: "primary", surfaceType: "governance", description: "Runtime, source, notifications, workflow defaults, and security settings.", keywords: ["settings", "notifications", "runtime", "llm", "git", "security"] },
  { id: "ops-access-keys", label: "Access Keys", href: "/operations/access-keys", group: "Administration", icon: KeyRound, priority: "primary", surfaceType: "identity" },
  { id: "identity-dashboard", label: "Identity Dashboard", href: "/identity/dashboard", group: "Administration", icon: LayoutDashboard, priority: "primary", surfaceType: "identity" },
  { id: "identity-users", label: "Users", href: "/identity/users", group: "Administration", icon: Users, priority: "primary", surfaceType: "identity" },
  { id: "identity-teams", label: "Teams", href: "/identity/teams", group: "Administration", icon: Network, priority: "primary", surfaceType: "identity" },
  { id: "identity-roles", label: "Roles", href: "/identity/roles", group: "Administration", icon: ShieldCheck, priority: "primary", surfaceType: "identity" },
  { id: "identity-permissions", label: "Permissions", href: "/identity/permissions", group: "Administration", icon: ShieldCheck, priority: "secondary", surfaceType: "identity" },
  { id: "identity-capabilities", label: "IAM Capabilities", href: "/identity/capabilities", group: "Administration", icon: GitBranch, priority: "secondary", surfaceType: "identity" },
  { id: "identity-effective-access", label: "Effective Access", href: "/identity/effective-access", group: "Administration", icon: ShieldCheck, priority: "secondary", surfaceType: "identity", description: "See permissions effective for the current tenant and session." },
  { id: "identity-audit", label: "Identity Audit", href: "/identity/audit", group: "Administration", icon: FileText, priority: "secondary", surfaceType: "identity" },
  { id: "help", label: "Platform Guide", href: "/help", group: "Administration", icon: BookOpen, priority: "secondary", surfaceType: "launch", description: "Learn WorkItems, workflows, events, runtimes, node options, and troubleshooting.", keywords: ["help", "guide", "docs", "workitem", "event", "node", "workflow", "runbook"] },
  { id: "tool-grants", label: "Tool Grants", href: "/tool-grants", group: "Administration", icon: KeyRound, advanced: true, priority: "admin", surfaceType: "agent" },
  { id: "identity-mcp-servers", label: "MCP Servers", href: "/identity/mcp-servers", group: "Administration", icon: Network, advanced: true, priority: "admin", surfaceType: "identity", description: "Register MCP tool servers available to each capability.", keywords: ["mcp", "server", "tool", "registry", "capability"] },
  { id: "identity-business-units", label: "Business Units", href: "/identity/business-units", group: "Administration", icon: Layers, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-capability-graph", label: "Capability Graph", href: "/identity/capability-graph", group: "Administration", icon: Route, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-variables", label: "Variables", href: "/identity/variables", group: "Administration", icon: Globe, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-authz-check", label: "Authorization Check", href: "/identity/authz-check", group: "Administration", icon: ClipboardCheck, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-sharing-grants", label: "Sharing Grants", href: "/identity/sharing-grants", group: "Administration", icon: Link2, advanced: true, priority: "admin", surfaceType: "identity" },
  { id: "identity-git-connections", label: "GitHub Connections", href: "/identity/git-connections", group: "Administration", icon: GitBranch, advanced: true, priority: "admin", surfaceType: "identity", description: "Per-tenant GitHub App installations for the Git credential broker.", keywords: ["git", "github", "app", "credential", "broker", "token"] },
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
