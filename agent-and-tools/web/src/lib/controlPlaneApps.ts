import type { LucideIcon } from "lucide-react";
import { Bot, ServerCog, ShieldCheck, Workflow, Wrench } from "lucide-react";

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
  const workgraphBase = process.env.NEXT_PUBLIC_LINK_WORKGRAPH_DESIGNER ?? localUrl(5174);
  const workbenchBase = process.env.NEXT_PUBLIC_LINK_BLUEPRINT_WORKBENCH ?? localUrl(5176, "/?ui=neo");
  const identityBase = process.env.NEXT_PUBLIC_LINK_IAM_ADMIN ?? localUrl(5175);
  const operationsBase = process.env.NEXT_PUBLIC_LINK_OPERATIONS_PORTAL ?? localUrl(5180, "/operations");

  return [
    {
      id: "agent-studio",
      label: "Agent Studio",
      group: "Agent Runtime",
      href: "/agent-studio",
      nativeHref: "/agent-studio",
      summary: "Agents, capability teams, tools, prompt profiles, and model settings.",
      icon: Bot,
    },
    {
      id: "workflows",
      label: "Workflows",
      group: "Workgraph",
      href: "/workflows",
      nativeHref: process.env.NEXT_PUBLIC_LINK_WORKGRAPH_WORKFLOWS ?? `${workgraphBase.replace(/\/$/, "")}/workflows`,
      summary: "Workflow templates, designer, node settings, and run launch.",
      icon: Workflow,
    },
    {
      id: "runs",
      label: "Runs",
      group: "Workgraph",
      href: "/runs",
      nativeHref: process.env.NEXT_PUBLIC_LINK_WORKGRAPH_RUNS ?? `${workgraphBase.replace(/\/$/, "")}/runs`,
      summary: "Mission Control, approvals, live events, stage restarts, and run evidence.",
      icon: Workflow,
    },
    {
      id: "work-items",
      label: "WorkItems",
      group: "Workgraph",
      href: "/work-items",
      nativeHref: process.env.NEXT_PUBLIC_LINK_WORKGRAPH_WORKITEMS ?? `${workgraphBase.replace(/\/$/, "")}/work-items`,
      summary: "Capability-scoped work queue, parent delegation, attach workflow, and start.",
      icon: Workflow,
    },
    {
      id: "workbench",
      label: "WorkbenchNeo",
      group: "Delivery",
      href: "/workbench",
      nativeHref: workbenchBase,
      summary: "Story-to-delivery stages, artifacts, approvals, terminal, and code review.",
      icon: Wrench,
    },
    {
      id: "identity",
      label: "Identity",
      group: "IAM",
      href: "/identity",
      nativeHref: `${identityBase.replace(/\/$/, "")}/capabilities`,
      summary: "Users, teams, roles, capabilities, sharing grants, and authorization checks.",
      icon: ShieldCheck,
    },
    {
      id: "operations",
      label: "Operations",
      group: "Operations",
      href: "/operations",
      nativeHref: operationsBase,
      summary: "Setup Center, readiness, audit packs, architecture, and trust evidence.",
      icon: ServerCog,
    },
  ];
}

export function getControlPlaneApp(id: string): ControlPlaneApp {
  return controlPlaneApps().find((app) => app.id === id) ?? controlPlaneApps()[0];
}
