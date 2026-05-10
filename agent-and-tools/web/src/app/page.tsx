import { Bot, Wrench, Play, Users } from "lucide-react";
import Link from "next/link";

async function fetchCount(url: string, key: string): Promise<number> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json() as Record<string, unknown[]>;
    return (data[key] ?? []).length;
  } catch {
    return 0;
  }
}

export default async function DashboardPage() {
  const agentBase = process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";
  const toolBase  = process.env.TOOL_SERVICE_URL  ?? "http://localhost:3002";
  const [agents, tools, executions, runners] = await Promise.all([
    fetchCount(`${agentBase}/api/v1/agents`,             "agents"),
    fetchCount(`${toolBase}/api/v1/tools`,               "tools"),
    fetchCount(`${toolBase}/api/v1/tools/executions`,    "executions"),
    fetchCount(`${toolBase}/api/v1/client-runners`,      "runners"),
  ]);

  const stats = [
    { label: "Agents",     value: agents,     icon: Bot,   href: "/agents",     color: "#00843D", bg: "rgba(0,132,61,0.10)" },
    { label: "Tools",      value: tools,      icon: Wrench,href: "/tools",      color: "#004B8D", bg: "rgba(0,75,141,0.10)" },
    { label: "Executions", value: executions, icon: Play,  href: "/executions", color: "#6d28d9", bg: "rgba(109,40,217,0.10)" },
    { label: "Runners",    value: runners,    icon: Users,  href: "/runners",    color: "#c2410c", bg: "rgba(194,65,12,0.10)" },
  ];

  const architecture = [
    { title: "Agent Registry",   desc: "Agents, versions, learning profiles, runtime profiles" },
    { title: "Tool Registry",    desc: "Tool registration, discovery, access control, versioning" },
    { title: "Execution Plane",  desc: "Server, edge, browser, and local runner execution" },
    { title: "Context Fabric",   desc: "Compiles prompts, manages LLM calls and sessions" },
  ];

  return (
    <div style={{ maxWidth: 1200 }}>

      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <h1 className="page-header">Dashboard</h1>
        <p style={{ color: "var(--color-outline)", marginTop: 4, fontSize: "0.875rem" }}>
          SingularityNeo — Agent Registry &amp; Tool Execution Plane
        </p>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16, marginBottom: 28 }}>
        {stats.map(({ label, value, icon: Icon, href, color, bg }) => (
          <Link key={label} href={href} style={{ textDecoration: "none" }}>
            <div className="card card-hover" style={{ padding: 20, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span
                  className="label-xs"
                  style={{ color: "var(--color-outline)" }}
                >
                  {label}
                </span>
                <span
                  style={{
                    width: 34, height: 34, borderRadius: 8,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: bg, color: color,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={17} />
                </span>
              </div>
              <div
                style={{
                  fontFamily: "'Public Sans', sans-serif",
                  fontSize: "1.625rem",
                  fontWeight: 800,
                  color: "var(--color-on-surface)",
                  lineHeight: 1,
                }}
              >
                {value}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Architecture overview */}
      <div className="card" style={{ padding: 24 }}>
        {/* Section header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span
            style={{
              width: 3, height: 16, borderRadius: 2,
              background: "var(--color-primary)", flexShrink: 0,
            }}
          />
          <span
            className="label-xs"
            style={{ color: "var(--color-on-surface-variant)", letterSpacing: "0.12em" }}
          >
            Platform Architecture
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {architecture.map(({ title, desc }) => (
            <div
              key={title}
              style={{
                background: "var(--color-surface-low)",
                border: "1px solid var(--color-outline-variant)",
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div
                style={{
                  fontFamily: "'Public Sans', sans-serif",
                  fontWeight: 700,
                  fontSize: "0.8125rem",
                  color: "var(--color-on-surface)",
                  marginBottom: 4,
                }}
              >
                {title}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--color-outline)", lineHeight: 1.5 }}>
                {desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
