import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  GitBranch,
  Hammer,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type CountResult = { value: number | string; state: "live" | "guarded" | "offline" };

async function fetchCount(url: string, keys: string[]): Promise<CountResult> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return { value: "Guarded", state: "guarded" };
    const text = await res.text();
    if (!res.ok) return { value: "Check", state: "offline" };
    const data = text ? JSON.parse(text) as Record<string, unknown> : {};
    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value)) return { value: value.length, state: "live" };
      if (typeof value === "number") return { value, state: "live" };
    }
    if (Array.isArray(data.items)) return { value: data.items.length, state: "live" };
    if (Array.isArray(data.content)) return { value: data.content.length, state: "live" };
    return { value: "Live", state: "live" };
  } catch {
    return { value: "Check", state: "offline" };
  }
}

const loop = [
  {
    label: "Intake",
    title: "Shape Work",
    href: "/work-items",
    icon: ClipboardList,
    detail: "WorkItems, roadmap, and capability context",
    tone: "#004b8d",
  },
  {
    label: "Plan",
    title: "Design Flow",
    href: "/workflows/planner",
    icon: Workflow,
    detail: "Templates, designer, metadata, and run inputs",
    tone: "#368727",
  },
  {
    label: "Assign",
    title: "Bind Agents",
    href: "/agents/studio",
    icon: Bot,
    detail: "Profiles, skills, tools, prompt policies, and grants",
    tone: "#6d28d9",
  },
  {
    label: "Build",
    title: "Generate Code",
    href: "/foundry",
    icon: Hammer,
    detail: "Specs, repos, gaps, patch tasks, and receipts",
    tone: "#b45309",
  },
  {
    label: "Verify",
    title: "Prove Changes",
    href: "/workbench/cockpit",
    icon: FileCheck2,
    detail: "Workbench runs, governance checks, artifacts, and review",
    tone: "#0f766e",
  },
  {
    label: "Operate",
    title: "Watch Runtime",
    href: "/operations/readiness",
    icon: Network,
    detail: "Readiness, topology, trust, costs, and infrastructure",
    tone: "#475569",
  },
  {
    label: "Audit",
    title: "Trace Evidence",
    href: "/audit",
    icon: ShieldCheck,
    detail: "Contracts, receipts, lifecycle history, and policy proof",
    tone: "#15803d",
  },
  {
    label: "Learn",
    title: "Promote Memory",
    href: "/learning",
    icon: Brain,
    detail: "Lessons, memory promotion, benchmarks, and reuse",
    tone: "#be123c",
  },
] satisfies Array<{ label: string; title: string; href: string; icon: LucideIcon; detail: string; tone: string }>;

const commandActions = [
  { label: "Create Agent", href: "/agents/studio", icon: Bot, primary: true },
  { label: "Start Workflow", href: "/workflows/run", icon: Play },
  { label: "Open Foundry", href: "/foundry", icon: Hammer },
  { label: "Review Receipts", href: "/runtime-executions", icon: Activity },
  { label: "Governance Engine", href: "/engine", icon: Zap },
  { label: "Tool Grants", href: "/tool-grants", icon: Wrench },
];

const evidenceLinks = [
  { label: "Workflow Runs", href: "/runs", icon: Activity },
  { label: "Foundry History", href: "/foundry/history", icon: GitBranch },
  { label: "Runtime Receipts", href: "/runtime-executions", icon: ShieldCheck },
  { label: "Trace Audit", href: "/audit", icon: FileCheck2 },
];

function valueTone(state: CountResult["state"]) {
  if (state === "live") return "#368727";
  if (state === "guarded") return "#004b8d";
  return "#b45309";
}

function Signal({ label, result }: { label: string; result: CountResult }) {
  return (
    <div className="card" style={{ padding: 14, borderRadius: 8, boxShadow: "none" }}>
      <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <strong style={{ fontSize: 22, color: valueTone(result.state) }}>{result.value}</strong>
        <span className={result.state === "live" ? "badge badge-active" : "badge badge-pending_approval"}>
          {result.state}
        </span>
      </div>
    </div>
  );
}

function ActionLink({ label, href, icon: Icon, primary }: { label: string; href: string; icon: LucideIcon; primary?: boolean }) {
  return (
    <Link href={href} className={primary ? "btn-primary" : "btn-secondary"} style={{ justifyContent: "center", minHeight: 40 }}>
      <Icon size={15} />
      {label}
    </Link>
  );
}

export default async function SdlcCommandCenterPage() {
  const agentBase = process.env.AGENT_SERVICE_URL ?? "http://platform-core:3001";
  const toolBase = process.env.TOOL_SERVICE_URL ?? "http://platform-core:3002";
  const runtimeBase = process.env.AGENT_RUNTIME_URL ?? "http://platform-core:3003";
  const workgraphBase = process.env.WORKGRAPH_API_URL ?? "http://workgraph-api:8080";

  const [agents, tools, templates, runs, foundryRuns, receipts] = await Promise.all([
    fetchCount(`${agentBase}/api/v1/agents`, ["agents", "items"]),
    fetchCount(`${toolBase}/api/v1/tools`, ["tools", "items"]),
    fetchCount(`${workgraphBase}/api/workflow-templates?size=1`, ["items", "content"]),
    fetchCount(`${workgraphBase}/api/workflow-instances?size=1`, ["items", "content"]),
    fetchCount(`${workgraphBase}/health`, ["status"]),
    fetchCount(`${runtimeBase}/api/v1/executions?size=1`, ["items", "content", "executions"]),
  ]);

  return (
    <div style={{ maxWidth: 1440 }}>
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(320px, 0.65fr)", gap: 18, alignItems: "stretch", marginBottom: 18 }}>
        <div className="card" style={{ padding: 24, borderRadius: 8 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
            <Sparkles size={15} />
            Agentic SDLC
          </div>
          <h1 className="page-header" style={{ margin: 0, fontSize: 34 }}>SDLC Command Center</h1>
          <p style={{ margin: "10px 0 0", maxWidth: 900, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
            Govern intake, agent assignment, workflow execution, code generation, verification, receipts, operations, and learning from one delivery loop.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 20 }}>
            {commandActions.map((action) => <ActionLink key={action.href} {...action} />)}
          </div>
        </div>

        <div className="card" style={{ padding: 18, borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Live Signals</h2>
            <CheckCircle2 size={16} color="var(--color-primary)" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            <Signal label="Agents" result={agents} />
            <Signal label="Tools" result={tools} />
            <Signal label="Templates" result={templates} />
            <Signal label="Runs" result={runs} />
            <Signal label="Foundry" result={foundryRuns} />
            <Signal label="Receipts" result={receipts} />
          </div>
        </div>
      </section>

      <section className="card" style={{ padding: 18, borderRadius: 8, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Delivery Loop</h2>
            <p style={{ margin: "4px 0 0", color: "var(--color-outline)", fontSize: 13 }}>Every stage links to a native Platform Web surface.</p>
          </div>
          <Link href="/operations/architecture" className="btn-secondary">
            <Network size={15} />
            Architecture
          </Link>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {loop.map((stage) => {
            const Icon = stage.icon;
            return (
              <Link key={stage.href} href={stage.href} style={{ textDecoration: "none" }}>
                <article className="card card-hover" style={{ padding: 16, borderRadius: 8, minHeight: 160, boxShadow: "none", borderColor: `${stage.tone}33` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <span style={{ width: 36, height: 36, borderRadius: 8, display: "grid", placeItems: "center", color: stage.tone, background: `${stage.tone}14` }}>
                      <Icon size={18} />
                    </span>
                    <span className="label-xs" style={{ color: stage.tone }}>{stage.label}</span>
                  </div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 850 }}>{stage.title}</h3>
                  <p style={{ margin: "7px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5 }}>{stage.detail}</p>
                  <div style={{ marginTop: 13, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, display: "flex", alignItems: "center", gap: 6 }}>
                    Open surface
                    <ArrowRight size={13} />
                  </div>
                </article>
              </Link>
            );
          })}
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 0.45fr)", gap: 18, alignItems: "start" }}>
        <div className="card" style={{ padding: 18, borderRadius: 8 }}>
          <h2 style={{ margin: "0 0 12px", fontSize: 18 }}>Evidence Rail</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            {evidenceLinks.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="btn-secondary" style={{ justifyContent: "space-between", minHeight: 44 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <Icon size={15} />
                    {item.label}
                  </span>
                  <ArrowRight size={13} />
                </Link>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 18, borderRadius: 8 }}>
          <h2 style={{ margin: "0 0 10px", fontSize: 18 }}>Operating Standard</h2>
          <div style={{ display: "grid", gap: 9, fontSize: 13, color: "var(--color-on-surface-variant)" }}>
            <div><strong>1.</strong> Work is capability-scoped.</div>
            <div><strong>2.</strong> Agents execute through filtered capabilities.</div>
            <div><strong>3.</strong> Prompts, tools, models, and evidence are pinned.</div>
            <div><strong>4.</strong> Replay and receipts prove what changed.</div>
            <div><strong>5.</strong> Lessons promote only after review.</div>
          </div>
        </div>
      </section>
    </div>
  );
}
