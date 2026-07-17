import type { LucideIcon } from "lucide-react";
import { Bot, ClipboardList, LayoutDashboard, ServerCog, ShieldCheck, Sparkles, Workflow } from "lucide-react";

export type ControlPlaneApp = {
  id: string;
  label: string;
  group: string;
  href: string;
  nativeHref: string;
  summary: string;
  icon: LucideIcon;
};

export function localUrl(port: number, path = "") {
  if (typeof window === "undefined") return `http://localhost:${port}${path}`;
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`;
}

export function controlPlaneApps(): ControlPlaneApp[] {
  return [
    {
      id: "command-center",
      label: "Command Center",
      group: "Home",
      href: "/",
      nativeHref: "/",
      summary: "Start governed work, resume delivery, and see platform signals.",
      icon: LayoutDashboard,
    },
    {
      id: "synthesis",
      label: "Synthesis",
      group: "Discover & Define",
      href: "/synthesis",
      nativeHref: "/synthesis",
      summary: "Ideas, evidence, decisions, specifications, economics, and learning.",
      icon: Sparkles,
    },
    {
      id: "work-management",
      label: "Work Management",
      group: "Plan",
      href: "/work-items",
      nativeHref: "/work-items",
      summary: "Plan, scope, route, and track capability-bound Work Items.",
      icon: ClipboardList,
    },
    {
      id: "agent-studio",
      label: "Agent Studio",
      group: "Define",
      href: "/agents/studio",
      nativeHref: "/agents/studio",
      summary: "Agents, capability teams, tools, prompt profiles, and model settings.",
      icon: Bot,
    },
    {
      id: "workflows",
      label: "Workflows",
      group: "Execute & Verify",
      href: "/workflows",
      nativeHref: "/workflows",
      summary: "Workflow design, launch, live runs, approvals, and delivery evidence.",
      icon: Workflow,
    },
    {
      id: "identity",
      label: "Identity & Access",
      group: "Administration",
      href: "/identity",
      nativeHref: "/identity",
      summary: "Users, teams, roles, capabilities, sharing grants, and authorization checks.",
      icon: ShieldCheck,
    },
    {
      id: "operations",
      label: "Platform Operations",
      group: "Operate",
      href: "/operations",
      nativeHref: "/operations",
      summary: "Setup Center, readiness, audit packs, architecture, and trust evidence.",
      icon: ServerCog,
    },
  ];
}

export function getControlPlaneApp(id: string): ControlPlaneApp {
  return controlPlaneApps().find((app) => app.id === id) ?? controlPlaneApps()[0];
}
