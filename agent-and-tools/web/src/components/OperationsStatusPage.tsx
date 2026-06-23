"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import useSWR from "swr";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  CloudCog,
  Database,
  FileCheck2,
  Gauge,
  GitBranch,
  KeyRound,
  ListChecks,
  Network,
  RefreshCw,
  Route,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { PlatformTopologyMap } from "@/components/PlatformTopologyMap";

type OperationsView = "overview" | "readiness" | "architecture" | "setup" | "trust";
type RuntimeStatus = "healthy" | "unhealthy" | "unreachable" | "not_configured";

type Check = {
  label: string;
  path: string;
  group: "identity" | "agent" | "workflow" | "context";
  description: string;
  evidence: string;
};

type CheckResult = Check & {
  result: { ok: boolean; status: number; body: string } | null;
};

type RuntimeInfrastructure = {
  generatedAt: string;
  summary: {
    requiredHealthy: boolean;
    requiredCount: number;
    optionalConfigured: number;
    optionalHealthy: number;
  };
  services: RuntimeService[];
};

type RuntimeService = {
  id: string;
  label: string;
  description: string;
  category: "core" | "runtime" | "governance";
  envKey: string;
  url: string | null;
  required: boolean;
  remoteCapable: boolean;
  status: RuntimeStatus;
  ok: boolean | null;
  httpStatus: number | null;
  message: string;
  checkedAt: string;
};

type Tone = {
  label: string;
  fg: string;
  bg: string;
  border: string;
  icon: LucideIcon;
};

const checks: Check[] = [
  {
    label: "IAM",
    path: "/ops-health/iam",
    group: "identity",
    description: "Login, session verification, users, teams, roles, and capability permissions.",
    evidence: "Authentication boundary",
  },
  {
    label: "Agent Service",
    path: "/ops-health/agent-service",
    group: "agent",
    description: "Agent catalog, profile metadata, learning, and agent lifecycle APIs.",
    evidence: "Agent profile control plane",
  },
  {
    label: "Tool Service",
    path: "/ops-health/tool-service",
    group: "agent",
    description: "Tool catalog, grants, source-backed bindings, and tool metadata.",
    evidence: "Capability and tool grants",
  },
  {
    label: "Agent Runtime",
    path: "/ops-health/agent-runtime",
    group: "agent",
    description: "Agent run snapshots, resolved profiles, receipts, and governed invocation APIs.",
    evidence: "Runtime execution receipts",
  },
  {
    label: "Prompt Composer",
    path: "/ops-health/prompt-composer",
    group: "agent",
    description: "Prompt profiles, assemblies, layers, compression, and response orchestration.",
    evidence: "Prompt assembly provenance",
  },
  {
    label: "Workgraph API",
    path: "/ops-health/workgraph-api",
    group: "workflow",
    description: "Workflow templates, running workflows, events, artifacts, and SSE streams.",
    evidence: "Workflow run ledger",
  },
  {
    label: "Context API",
    path: "/ops-health/context-api",
    group: "context",
    description: "Context Fabric memory, knowledge, receipts, and runtime bridge routing.",
    evidence: "Context Fabric audit trail",
  },
];

const operationsTabs: Array<{ view: OperationsView; href: string; label: string; icon: LucideIcon }> = [
  { view: "overview", href: "/operations", label: "Center", icon: Gauge },
  { view: "readiness", href: "/operations/readiness", label: "Readiness", icon: Activity },
  { view: "architecture", href: "/operations/architecture", label: "Live Map", icon: Network },
  { view: "setup", href: "/operations/setup", label: "Setup", icon: Wrench },
  { view: "trust", href: "/operations/trust", label: "Trust", icon: ClipboardCheck },
];

const setupCommands = [
  { label: "Start Docker stack", command: "./singularity.sh up" },
  { label: "Start app services only", command: "./bin/bare-metal-apps.sh" },
  { label: "Start MCP and LLM runtime", command: "./bin/bare-metal-runtime.sh" },
  { label: "Dial in runtime bridge", command: "./bin/laptop-bridge.sh" },
  { label: "Check topology", command: "./bin/check-bare-metal-topology.sh" },
];

async function check(path: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(path, { cache: "no-store" });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 600) };
}

async function runtimeInfrastructure(): Promise<RuntimeInfrastructure> {
  const res = await fetch(apiPath("/api/runtime-infrastructure"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  if (!parsed || typeof parsed !== "object") throw new Error(raw ? raw.slice(0, 300) : "Empty runtime infrastructure response");
  return parsed as RuntimeInfrastructure;
}

function checkTone(result: CheckResult["result"], loading: boolean): Tone {
  if (!result && loading) return { label: "Checking", fg: "#475569", bg: "#f8fafc", border: "#cbd5e1", icon: Activity };
  if (result?.ok) return { label: "Live", fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", icon: CheckCircle2 };
  if (result?.status === 0) return { label: "Unreachable", fg: "#991b1b", bg: "#fef2f2", border: "#fecaca", icon: XCircle };
  return { label: "Down", fg: "#991b1b", bg: "#fef2f2", border: "#fecaca", icon: XCircle };
}

function runtimeTone(service?: RuntimeService, loading = false): Tone {
  if (!service && loading) return { label: "Checking", fg: "#475569", bg: "#f8fafc", border: "#cbd5e1", icon: Activity };
  if (!service) return { label: "Unknown", fg: "#475569", bg: "#f8fafc", border: "#cbd5e1", icon: Activity };
  if (service.ok === true) return { label: "Healthy", fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", icon: CheckCircle2 };
  if (service.status === "not_configured" && !service.required) {
    return { label: "Optional", fg: "#64748b", bg: "#f8fafc", border: "#cbd5e1", icon: ServerCog };
  }
  if (!service.required) return { label: "Unavailable", fg: "#92400e", bg: "#fffbeb", border: "#fde68a", icon: Activity };
  return { label: service.status === "not_configured" ? "Missing" : "Down", fg: "#991b1b", bg: "#fef2f2", border: "#fecaca", icon: XCircle };
}

function serviceIcon(service: RuntimeService): LucideIcon {
  if (service.id === "context-api") return Database;
  if (service.id === "runtime-bridge") return Network;
  if (service.id === "mcp") return TerminalSquare;
  if (service.id === "llm-gateway") return CloudCog;
  if (service.category === "governance") return ShieldCheck;
  return ServerCog;
}

function formatTime(value?: string) {
  if (!value) return "not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not checked";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function parseJsonBody(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function shortValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 120);
}

function statusStyle(tone: Tone): CSSProperties {
  return { color: tone.fg, background: tone.bg, borderColor: tone.border };
}

export function OperationsStatusPage({
  title,
  description,
  view = "overview",
}: {
  title: string;
  description: string;
  view?: OperationsView;
}) {
  const { data, error, isLoading, mutate } = useSWR(
    "operations-status",
    async () => Promise.all(checks.map(async (item) => ({
      ...item,
      result: await check(item.path).catch((err) => ({ ok: false, status: 0, body: (err as Error).message })),
    }))),
    { refreshInterval: 10000 },
  );
  const { data: runtime, error: runtimeError, isLoading: runtimeLoading, mutate: refreshRuntime } = useSWR(
    "runtime-infrastructure",
    runtimeInfrastructure,
    { refreshInterval: 10000 },
  );

  const checkRows: CheckResult[] = data ?? checks.map((item) => ({ ...item, result: null }));
  const coreHealthy = checkRows.filter((item) => item.result?.ok).length;
  const coreDown = checkRows.filter((item) => item.result && !item.result.ok).length;
  const runtimeServices = runtime?.services ?? [];
  const requiredRuntimeDown = runtimeServices.filter((service) => service.required && service.ok === false).length;
  const runtimeBridge = runtimeServices.find((service) => service.id === "runtime-bridge");
  const allRequiredHealthy = coreDown === 0 && requiredRuntimeDown === 0 && Boolean(data);
  const generatedAt = runtime?.generatedAt;

  const refreshAll = () => {
    void mutate();
    void refreshRuntime();
  };

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {view !== "overview" && (
            <Link href="/operations" className="btn-secondary">
              <ArrowLeft size={15} />
              Operations
            </Link>
          )}
          {operationsTabs.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.view}
                href={item.href}
                className={item.view === view ? "btn-primary" : "btn-secondary"}
                aria-current={item.view === view ? "page" : undefined}
              >
                <Icon size={15} />
                {item.label}
              </Link>
            );
          })}
        </div>
        <button type="button" className="btn-secondary" onClick={refreshAll} disabled={isLoading || runtimeLoading}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <OperationsHero
        title={title}
        description={description}
        view={view}
        requiredHealthy={allRequiredHealthy}
        checkedAt={generatedAt}
      />

      {(error || runtimeError) && (
        <section className="card" style={{ padding: 16, borderColor: "#fecaca", background: "#fef2f2", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#991b1b", fontWeight: 800 }}>
            <XCircle size={17} />
            {error?.message || runtimeError?.message}
          </div>
        </section>
      )}

      {view === "overview" && (
        <OverviewView
          checks={checkRows}
          runtime={runtime}
          loading={isLoading || runtimeLoading}
          coreHealthy={coreHealthy}
          runtimeBridge={runtimeBridge}
        />
      )}
      {view === "readiness" && (
        <ReadinessView checks={checkRows} runtime={runtime} loading={isLoading || runtimeLoading} />
      )}
      {view === "architecture" && (
        <ArchitectureView runtimeBridge={runtimeBridge} runtime={runtime} />
      )}
      {view === "setup" && (
        <SetupView checks={checkRows} runtime={runtime} loading={isLoading || runtimeLoading} />
      )}
      {view === "trust" && (
        <TrustView checks={checkRows} runtime={runtime} loading={isLoading || runtimeLoading} />
      )}
    </div>
  );
}

function OperationsHero({
  title,
  description,
  view,
  requiredHealthy,
  checkedAt,
}: {
  title: string;
  description: string;
  view: OperationsView;
  requiredHealthy: boolean;
  checkedAt?: string;
}) {
  const Icon = operationsTabs.find((item) => item.view === view)?.icon ?? Gauge;
  const tone = requiredHealthy
    ? { fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", label: "Required healthy" }
    : { fg: "#92400e", bg: "#fffbeb", border: "#fde68a", label: "Needs attention" };
  return (
    <section className="card" style={{ padding: 24, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 14, minWidth: 0 }}>
          <span style={iconBox(tone.fg, tone.bg)}>
            <Icon size={24} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Operations Center</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>{title}</h1>
            <p style={{ color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6, margin: 0, maxWidth: 820 }}>{description}</p>
          </div>
        </div>
        <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
          <span className="badge" style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}>{tone.label}</span>
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>Checked {formatTime(checkedAt)}</span>
        </div>
      </div>
    </section>
  );
}

function OverviewView({
  checks,
  runtime,
  loading,
  coreHealthy,
  runtimeBridge,
}: {
  checks: CheckResult[];
  runtime?: RuntimeInfrastructure;
  loading: boolean;
  coreHealthy: number;
  runtimeBridge?: RuntimeService;
}) {
  const runtimeToneMeta = runtimeTone(runtimeBridge, loading);
  const RuntimeBridgeIcon = runtimeToneMeta.icon;
  const requiredRuntimeDown = runtime?.services.filter((service) => service.required && service.ok === false).length ?? 0;
  const tiles = [
    {
      href: "/operations/readiness",
      icon: Activity,
      title: "Readiness",
      value: `${coreHealthy}/${checks.length}`,
      description: "Required backend health, runtime checks, and failing endpoint details.",
      tone: coreHealthy === checks.length ? "#047857" : "#b45309",
    },
    {
      href: "/operations/architecture",
      icon: Network,
      title: "Live App Map",
      value: "Topology",
      description: "Connected UI domains, APIs, Context Fabric, runtime bridge, MCP, and LLM paths.",
      tone: "#2563eb",
    },
    {
      href: "/operations/setup",
      icon: Wrench,
      title: "Setup Center",
      value: runtime?.summary.requiredHealthy ? "Ready" : "Action",
      description: "Operator checklist, scripts, runtime dial-in, and environment targets.",
      tone: runtime?.summary.requiredHealthy ? "#047857" : "#b45309",
    },
    {
      href: "/operations/trust",
      icon: ClipboardCheck,
      title: "Trust Evidence",
      value: requiredRuntimeDown ? `${requiredRuntimeDown} gaps` : "Current",
      description: "Health-backed evidence for identity, prompts, workflows, runtime, and governance.",
      tone: requiredRuntimeDown ? "#b91c1c" : "#047857",
    },
  ];

  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, marginBottom: 18 }}>
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.href} href={tile.href} className="card card-hover" style={{ padding: 18, textDecoration: "none", color: "inherit" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <span style={iconBox(tile.tone, `${tile.tone}12`)}>
                  <Icon size={20} />
                </span>
                <strong style={{ color: tile.tone, fontSize: 18 }}>{tile.value}</strong>
              </div>
              <h2 style={{ margin: "14px 0 6px", fontSize: 16 }}>{tile.title}</h2>
              <p style={{ margin: 0, color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>{tile.description}</p>
            </Link>
          );
        })}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(300px, 0.8fr)", gap: 14, marginBottom: 18 }}>
        <article className="card" style={{ padding: 18 }}>
          <SectionTitle icon={ListChecks} title="Attention Queue" subtitle="Required checks that need operator focus." />
          <div style={{ display: "grid", gap: 10 }}>
            {checks.filter((item) => item.result && !item.result.ok).map((item) => (
              <HealthRow key={item.path} item={item} loading={loading} compact />
            ))}
            {runtime?.services.filter((service) => service.required && service.ok === false).map((service) => (
              <RuntimeRow key={service.id} service={service} compact />
            ))}
            {!checks.some((item) => item.result && !item.result.ok) && !runtime?.services.some((service) => service.required && service.ok === false) && (
              <EmptyNote icon={CheckCircle2} title="No required blockers" body="Core APIs and required runtime checks are currently green." />
            )}
          </div>
        </article>

        <article className="card" style={{ padding: 18 }}>
          <SectionTitle icon={CloudCog} title="Runtime Bridge" subtitle="MCP and LLM should dial into Context Fabric." />
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "14px 0" }}>
            <span style={iconBox(runtimeToneMeta.fg, runtimeToneMeta.bg)}>
              <RuntimeBridgeIcon size={20} />
            </span>
            <div>
              <div style={{ fontWeight: 850 }}>{runtimeBridge?.label ?? "Runtime Bridge"}</div>
              <span className="badge" style={statusStyle(runtimeToneMeta)}>{runtimeToneMeta.label}</span>
            </div>
          </div>
          <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.55, margin: 0 }}>
            {runtimeBridge?.message ?? "Waiting for Context Fabric runtime bridge status."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            <Pill>{runtime ? `${runtime.summary.optionalHealthy}/${runtime.summary.optionalConfigured} optional healthy` : "Runtime loading"}</Pill>
            <Pill>{runtimeBridge?.url ?? "Context Fabric URL pending"}</Pill>
          </div>
        </article>
      </section>
    </>
  );
}

function ReadinessView({
  checks,
  runtime,
  loading,
}: {
  checks: CheckResult[];
  runtime?: RuntimeInfrastructure;
  loading: boolean;
}) {
  const healthy = checks.filter((item) => item.result?.ok).length;
  const percent = checks.length ? Math.round((healthy / checks.length) * 100) : 0;
  const servicesByCategory = groupRuntimeServices(runtime?.services ?? []);

  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 18 }}>
        <MetricCard label="Core services" value={`${healthy}/${checks.length}`} tone={healthy === checks.length ? "#047857" : "#b45309"} icon={ServerCog} />
        <MetricCard label="Runtime required" value={runtime?.summary.requiredHealthy ? "Healthy" : runtime ? "Needs attention" : "..."} tone={runtime?.summary.requiredHealthy ? "#047857" : "#b45309"} icon={Network} />
        <MetricCard label="Optional runtimes" value={runtime ? `${runtime.summary.optionalHealthy}/${runtime.summary.optionalConfigured}` : "..."} tone="#2563eb" icon={CloudCog} />
        <MetricCard label="Readiness score" value={`${percent}%`} tone={percent === 100 ? "#047857" : "#b45309"} icon={Gauge} />
      </section>

      <section className="card" style={{ padding: 18, marginBottom: 18 }}>
        <SectionTitle icon={Activity} title="Core Platform Services" subtitle="Live endpoint checks used by the unified web shell." />
        <div className="progress-bar" style={{ margin: "12px 0 16px" }}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {checks.map((item) => <HealthCard key={item.path} item={item} loading={loading} />)}
        </div>
      </section>

      <section className="card" style={{ padding: 18 }}>
        <SectionTitle icon={CloudCog} title="Runtime Infrastructure" subtitle="Required fabric services and optional dial-in/debug services." />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 14 }}>
          {Object.entries(servicesByCategory).map(([category, services]) => (
            <article key={category} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 14 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 14, textTransform: "capitalize" }}>{category}</h3>
              <div style={{ display: "grid", gap: 10 }}>
                {services.map((service) => <RuntimeRow key={service.id} service={service} compact />)}
              </div>
            </article>
          ))}
          {!runtime?.services?.length && <EmptyNote icon={Activity} title="Runtime status loading" body="Waiting for runtime infrastructure telemetry." />}
        </div>
      </section>
    </>
  );
}

function ArchitectureView({
  runtimeBridge,
  runtime,
}: {
  runtimeBridge?: RuntimeService;
  runtime?: RuntimeInfrastructure;
}) {
  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, marginBottom: 18 }}>
        <InfoCard icon={Route} title="Single web entry" value=":5180" body="Platform Web owns the route tree and proxies backend calls from one UI container." tone="#2563eb" />
        <InfoCard icon={Database} title="Context Fabric" value="runtime hub" body="Workflow, prompt, memory, and runtime bridge traffic converge through Context Fabric." tone="#047857" />
        <InfoCard icon={CloudCog} title="Runtime dial-in" value={runtimeTone(runtimeBridge).label} body={runtimeBridge?.message ?? "Runtime Bridge status is loading."} tone={runtimeBridge?.ok ? "#047857" : "#b45309"} />
        <InfoCard icon={TerminalSquare} title="Debug HTTP" value={runtime ? `${runtime.summary.optionalConfigured} configured` : "..."} body="MCP and LLM direct URLs are diagnostics or explicit fallback paths." tone="#64748b" />
      </section>
      <PlatformTopologyMap />
    </>
  );
}

function SetupView({
  checks,
  runtime,
  loading,
}: {
  checks: CheckResult[];
  runtime?: RuntimeInfrastructure;
  loading: boolean;
}) {
  const checkByLabel = new Map(checks.map((item) => [item.label, item]));
  const serviceById = new Map((runtime?.services ?? []).map((service) => [service.id, service]));
  const steps = [
    {
      title: "Identity and session",
      detail: "IAM responds and the browser can verify a session token.",
      done: Boolean(checkByLabel.get("IAM")?.result?.ok),
      href: "/identity",
    },
    {
      title: "Core application APIs",
      detail: "Agent, Tool, Runtime, Prompt Composer, Workgraph, and Context APIs are reachable.",
      done: checks.every((item) => item.result?.ok),
      href: "/operations/readiness",
    },
    {
      title: "Context Fabric",
      detail: "Context API is healthy and can host runtime bridge connections.",
      done: Boolean(checkByLabel.get("Context API")?.result?.ok),
      href: "/operations/architecture",
    },
    {
      title: "Runtime Bridge",
      detail: "MCP runtime can dial in and advertise tool-run/model-run/code-context frames.",
      done: serviceById.get("runtime-bridge")?.ok === true,
      href: "/llm-settings",
    },
    {
      title: "Optional runtime services",
      detail: "MCP HTTP debug, LLM Gateway, verifier, and audit services are configured as needed.",
      done: Boolean(runtime && runtime.summary.optionalConfigured > 0),
      href: "/operations/access-keys",
    },
  ];

  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.85fr)", gap: 14, marginBottom: 18 }}>
        <article className="card" style={{ padding: 18 }}>
          <SectionTitle icon={ListChecks} title="Setup Checklist" subtitle="Bring the platform from local stack to runtime-ready state." />
          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {steps.map((step, index) => (
              <Link key={step.title} href={step.href} className="card card-hover" style={{ padding: 14, display: "grid", gridTemplateColumns: "36px minmax(0, 1fr) auto", gap: 12, alignItems: "center", boxShadow: "none", textDecoration: "none", color: "inherit" }}>
                <span style={iconBox(step.done ? "#047857" : "#92400e", step.done ? "#ecfdf5" : "#fffbeb")}>
                  {step.done ? <CheckCircle2 size={18} /> : <span style={{ fontWeight: 850 }}>{index + 1}</span>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <strong>{step.title}</strong>
                  <span style={{ display: "block", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, marginTop: 3 }}>{step.detail}</span>
                </span>
                <span className="badge" style={step.done ? { color: "#047857", background: "#ecfdf5", borderColor: "#a7f3d0" } : { color: "#92400e", background: "#fffbeb", borderColor: "#fde68a" }}>
                  {loading && !step.done ? "Checking" : step.done ? "Done" : "Open"}
                </span>
              </Link>
            ))}
          </div>
        </article>

        <article className="card" style={{ padding: 18 }}>
          <SectionTitle icon={TerminalSquare} title="Operator Commands" subtitle="Scripts for Docker, bare metal apps, and remote runtimes." />
          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {setupCommands.map((item) => (
              <div key={item.command} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{item.label}</div>
                <code style={{ display: "block", background: "var(--color-surface-low)", border: "1px solid var(--color-outline-variant)", borderRadius: 6, padding: "8px 10px", fontSize: 12, overflowX: "auto" }}>{item.command}</code>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="card" style={{ padding: 18 }}>
        <SectionTitle icon={KeyRound} title="Environment Targets" subtitle="Configured service URLs and the env vars that control them." />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 14 }}>
          {(runtime?.services ?? []).map((service) => <RuntimeConfigCard key={service.id} service={service} />)}
          {!runtime?.services?.length && <EmptyNote icon={ServerCog} title="Runtime config loading" body="Waiting for runtime infrastructure telemetry." />}
        </div>
      </section>
    </>
  );
}

function TrustView({
  checks,
  runtime,
  loading,
}: {
  checks: CheckResult[];
  runtime?: RuntimeInfrastructure;
  loading: boolean;
}) {
  const checkByLabel = new Map(checks.map((item) => [item.label, item]));
  const serviceById = new Map((runtime?.services ?? []).map((service) => [service.id, service]));
  const groups = [
    {
      title: "Identity Evidence",
      icon: ShieldCheck,
      route: "/identity/audit",
      sources: [sourceFromCheck(checkByLabel.get("IAM"), loading)],
    },
    {
      title: "Agent and Prompt Evidence",
      icon: FileCheck2,
      route: "/prompt-workbench",
      sources: [
        sourceFromCheck(checkByLabel.get("Agent Service"), loading),
        sourceFromCheck(checkByLabel.get("Tool Service"), loading),
        sourceFromCheck(checkByLabel.get("Prompt Composer"), loading),
        sourceFromCheck(checkByLabel.get("Agent Runtime"), loading),
      ],
    },
    {
      title: "Workflow Evidence",
      icon: GitBranch,
      route: "/workflows/history",
      sources: [
        sourceFromCheck(checkByLabel.get("Workgraph API"), loading),
        sourceFromCheck(checkByLabel.get("Context API"), loading),
      ],
    },
    {
      title: "Runtime Dial-In Evidence",
      icon: CloudCog,
      route: "/llm-settings",
      sources: [
        sourceFromService(serviceById.get("runtime-bridge"), loading),
        sourceFromService(serviceById.get("mcp"), loading),
        sourceFromService(serviceById.get("llm-gateway"), loading),
      ],
    },
    {
      title: "Governance Evidence",
      icon: ClipboardCheck,
      route: "/audit",
      sources: [
        sourceFromService(serviceById.get("formal-verifier"), loading),
        sourceFromService(serviceById.get("audit-governance"), loading),
      ],
    },
  ];
  const evidenceRows = [
    ...checks.map((item) => sourceFromCheck(item, loading)),
    ...(runtime?.services ?? []).map((service) => sourceFromService(service, loading)),
  ];

  return (
    <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, marginBottom: 18 }}>
        {groups.map((group) => <EvidenceGroupCard key={group.title} group={group} />)}
      </section>

      <section className="card" style={{ padding: 18 }}>
        <SectionTitle icon={ClipboardCheck} title="Evidence Records" subtitle="Rendered health payloads and runtime probe messages." />
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          {evidenceRows.map((row) => <EvidenceRecord key={`${row.kind}-${row.label}`} row={row} />)}
        </div>
      </section>
    </>
  );
}

function HealthCard({ item, loading }: { item: CheckResult; loading: boolean }) {
  const tone = checkTone(item.result, loading);
  const Icon = tone.icon;
  return (
    <article className="card" style={{ padding: 15, boxShadow: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
          <span style={iconBox(tone.fg, tone.bg)}>
            <Icon size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 850 }}>{item.label}</div>
            <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 2 }}>{item.path}</div>
          </div>
        </div>
        <span className="badge" style={statusStyle(tone)}>{tone.label}</span>
      </div>
      <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, margin: "0 0 10px" }}>{item.description}</p>
      <PayloadPreview body={item.result?.body} fallback={item.result ? `${item.result.status}` : "Loading..."} />
    </article>
  );
}

function HealthRow({ item, loading, compact = false }: { item: CheckResult; loading: boolean; compact?: boolean }) {
  const tone = checkTone(item.result, loading);
  const Icon = tone.icon;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: compact ? 10 : 12 }}>
      <span style={iconBox(tone.fg, tone.bg)}>
        <Icon size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <strong>{item.label}</strong>
          <span className="badge" style={statusStyle(tone)}>{tone.label}</span>
        </div>
        <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 3 }}>{item.path}</div>
        {!compact && <PayloadPreview body={item.result?.body} fallback="Waiting for response" />}
      </div>
    </div>
  );
}

function RuntimeRow({ service, compact = false }: { service: RuntimeService; compact?: boolean }) {
  const tone = runtimeTone(service);
  const Icon = serviceIcon(service);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: compact ? 10 : 12 }}>
      <span style={iconBox(tone.fg, tone.bg)}>
        <Icon size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <strong>{service.label}</strong>
          <span className="badge" style={statusStyle(tone)}>{tone.label}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          <Pill>{service.required ? "required" : "optional"}</Pill>
          <Pill>{service.envKey}</Pill>
          {service.remoteCapable && <Pill>remote capable</Pill>}
        </div>
        {!compact && <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, margin: "8px 0 0" }}>{service.message}</p>}
      </div>
    </div>
  );
}

function RuntimeConfigCard({ service }: { service: RuntimeService }) {
  const tone = runtimeTone(service);
  return (
    <article style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <div>
          <strong>{service.label}</strong>
          <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 2 }}>{service.envKey}</div>
        </div>
        <span className="badge" style={statusStyle(tone)}>{tone.label}</span>
      </div>
      <div style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>{service.description}</div>
      <code style={{ display: "block", background: "var(--color-surface-low)", border: "1px solid var(--color-outline-variant)", borderRadius: 6, padding: "8px 10px", fontSize: 11, overflowX: "auto" }}>
        {service.url ?? "not configured"}
      </code>
    </article>
  );
}

function EvidenceGroupCard({
  group,
}: {
  group: {
    title: string;
    icon: LucideIcon;
    route: string;
    sources: EvidenceSource[];
  };
}) {
  const live = group.sources.filter((source) => source.ok === true).length;
  const hardFailures = group.sources.filter((source) => source.required && source.ok === false).length;
  const tone = hardFailures
    ? { fg: "#991b1b", bg: "#fef2f2", border: "#fecaca", label: `${hardFailures} gap${hardFailures === 1 ? "" : "s"}` }
    : live
      ? { fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", label: `${live}/${group.sources.length} live` }
      : { fg: "#64748b", bg: "#f8fafc", border: "#cbd5e1", label: "Pending" };
  const Icon = group.icon;
  return (
    <Link href={group.route} className="card card-hover" style={{ padding: 16, textDecoration: "none", color: "inherit" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <span style={iconBox(tone.fg, tone.bg)}>
          <Icon size={19} />
        </span>
        <span className="badge" style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}>{tone.label}</span>
      </div>
      <h2 style={{ margin: "13px 0 10px", fontSize: 15 }}>{group.title}</h2>
      <div style={{ display: "grid", gap: 7 }}>
        {group.sources.map((source, index) => (
          <div key={`${source.kind}-${source.label}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--color-outline)", fontSize: 12 }}>
            <span>{source.label}</span>
            <strong style={{ color: source.ok === true ? "#047857" : source.ok === false && source.required ? "#991b1b" : "#64748b" }}>{source.status}</strong>
          </div>
        ))}
      </div>
    </Link>
  );
}

type EvidenceSource = {
  label: string;
  kind: "health" | "runtime";
  status: string;
  ok: boolean | null;
  required: boolean;
  endpoint: string;
  message: string;
  checkedAt?: string;
  body?: string;
};

function sourceFromCheck(item: CheckResult | undefined, loading: boolean): EvidenceSource {
  const tone = checkTone(item?.result ?? null, loading);
  return {
    label: item?.label ?? "Unknown check",
    kind: "health",
    status: tone.label,
    ok: item?.result?.ok ?? null,
    required: true,
    endpoint: item?.path ?? "-",
    message: item?.description ?? "Waiting for health check metadata.",
    body: item?.result?.body,
  };
}

function sourceFromService(service: RuntimeService | undefined, loading: boolean): EvidenceSource {
  const tone = runtimeTone(service, loading);
  return {
    label: service?.label ?? "Runtime service",
    kind: "runtime",
    status: tone.label,
    ok: service?.ok ?? null,
    required: service?.required ?? false,
    endpoint: service?.url ?? service?.envKey ?? "not configured",
    message: service?.message ?? "Waiting for runtime probe.",
    checkedAt: service?.checkedAt,
  };
}

function EvidenceRecord({ row }: { row: EvidenceSource }) {
  const tone = row.ok === true
    ? { fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0" }
    : row.ok === false && row.required
      ? { fg: "#991b1b", bg: "#fef2f2", border: "#fecaca" }
      : { fg: "#64748b", bg: "#f8fafc", border: "#cbd5e1" };
  return (
    <article style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, alignItems: "start", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
      <div>
        <strong>{row.label}</strong>
        <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>{row.kind}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--color-outline)", fontSize: 12, wordBreak: "break-word" }}>{row.endpoint}</div>
        <PayloadPreview body={row.body} fallback={row.message} compact />
      </div>
      <div style={{ display: "grid", justifyItems: "end", gap: 6 }}>
        <span className="badge" style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}>{row.status}</span>
        <span style={{ color: "var(--color-outline)", fontSize: 11 }}>{formatTime(row.checkedAt)}</span>
      </div>
    </article>
  );
}

function PayloadPreview({ body, fallback, compact = false }: { body?: string; fallback: string; compact?: boolean }) {
  const parsed = parseJsonBody(body);
  if (parsed) {
    const entries = Object.entries(parsed).slice(0, compact ? 3 : 5);
    return (
      <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
        {entries.map(([key, value]) => (
          <div key={key} style={{ display: "grid", gridTemplateColumns: "96px minmax(0, 1fr)", gap: 8, fontSize: 11 }}>
            <span style={{ color: "var(--color-outline)", fontFamily: "var(--font-mono)" }}>{key}</span>
            <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortValue(value)}</strong>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ color: "var(--color-outline)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.45, marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {body || fallback}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={iconBox("#2563eb", "#eff6ff")}>
        <Icon size={17} />
      </span>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 850, margin: 0 }}>{title}</h2>
        <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "4px 0 0" }}>{subtitle}</p>
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone, icon: Icon }: { label: string; value: unknown; tone: string; icon: LucideIcon }) {
  return (
    <article className="card" style={{ padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <span style={iconBox(tone, `${tone}12`)}>
          <Icon size={17} />
        </span>
        <strong style={{ color: tone, fontSize: 18 }}>{String(value)}</strong>
      </div>
      <div className="label-xs" style={{ color: "var(--color-outline)", marginTop: 12 }}>{label}</div>
    </article>
  );
}

function InfoCard({ icon: Icon, title, value, body, tone }: { icon: LucideIcon; title: string; value: string; body: string; tone: string }) {
  return (
    <article className="card" style={{ padding: 16, boxShadow: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <span style={iconBox(tone, `${tone}12`)}>
          <Icon size={18} />
        </span>
        <strong style={{ color: tone }}>{value}</strong>
      </div>
      <h2 style={{ margin: "12px 0 6px", fontSize: 15 }}>{title}</h2>
      <p style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45, margin: 0 }}>{body}</p>
    </article>
  );
}

function EmptyNote({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 16, display: "flex", gap: 12, alignItems: "center", color: "var(--color-outline)" }}>
      <span style={iconBox("#047857", "#ecfdf5")}>
        <Icon size={17} />
      </span>
      <span>
        <strong style={{ color: "var(--color-on-surface)" }}>{title}</strong>
        <span style={{ display: "block", fontSize: 12, lineHeight: 1.45, marginTop: 3 }}>{body}</span>
      </span>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="badge" style={{ background: "var(--color-surface-low)", borderColor: "var(--color-outline-variant)", color: "var(--color-outline)" }}>
      {children}
    </span>
  );
}

function iconBox(color: string, background: string): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color,
    background,
    flexShrink: 0,
  };
}

function groupRuntimeServices(services: RuntimeService[]) {
  return services.reduce<Record<string, RuntimeService[]>>((acc, service) => {
    if (!acc[service.category]) acc[service.category] = [];
    acc[service.category].push(service);
    return acc;
  }, {});
}
