"use client";

import Link from "next/link";
import type { ReactNode } from "react";
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
import { asBoolean, asRow, asRowArray, asString } from "@/lib/row";
import { PlatformTopologyMap } from "@/components/PlatformTopologyMap";
import {
  CommandBlock,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  StatusChip,
  type UiState,
} from "@/components/ui/primitives";

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
  strictChecks: RuntimeStrictCheck[];
  strictFailureSummary?: string;
  checkedAt: string;
};

type RuntimeStrictCheck = {
  name: string;
  ok: boolean;
  reason?: string;
};

type AdoptionHealth = {
  score: number;
  summary?: {
    ready?: number;
    warning?: number;
    blocked?: number;
    connectedRuntimeCount?: number;
    readyProviderCount?: number;
    seededIntentCount?: number;
  };
  blocked?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
  warning?: Array<{ id: string; label: string; summary: string; fixCommand?: string; fixRoute?: string }>;
};

// Maps the page's nuanced health states onto the kit's StatusChip vocabulary.
type UiTone = { state: UiState; label: string; icon: LucideIcon };

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

const CARD = "rounded-xl border border-slate-200 bg-white shadow-sm";

// Tailwind tints for the small icon badges, keyed by the shared UiState.
const TINT: Record<UiState, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  waiting: "bg-amber-50 text-amber-700",
  blocked: "bg-red-50 text-red-700",
  offline: "bg-slate-100 text-slate-500",
  guarded: "bg-blue-50 text-blue-700",
  optional: "bg-slate-50 text-slate-500",
  "needs-auth": "bg-blue-50 text-blue-700",
  "needs-runtime": "bg-violet-50 text-violet-700",
  degraded: "bg-amber-50 text-amber-700",
};

async function check(path: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(path, { cache: "no-store" });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 600) };
}

async function runtimeInfrastructure(): Promise<RuntimeInfrastructure> {
  const res = await fetch(apiPath("/api/runtime-infrastructure"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return normalizeRuntimeInfrastructure(parsed);
}

async function adoptionHealth(): Promise<AdoptionHealth> {
  const res = await fetch(apiPath("/api/adoption/health"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return normalizeAdoptionHealth(parsed);
}

function checkUiTone(result: CheckResult["result"], loading: boolean): UiTone {
  if (!result && loading) return { state: "waiting", label: "Checking", icon: Activity };
  if (result?.ok) return { state: "ready", label: "Live", icon: CheckCircle2 };
  if (result?.status === 0) return { state: "offline", label: "Unreachable", icon: XCircle };
  return { state: "blocked", label: "Down", icon: XCircle };
}

function runtimeUiTone(service?: RuntimeService, loading = false): UiTone {
  if (!service && loading) return { state: "waiting", label: "Checking", icon: Activity };
  if (!service) return { state: "offline", label: "Unknown", icon: Activity };
  if (service.ok === true) return { state: "ready", label: "Healthy", icon: CheckCircle2 };
  if (service.status === "not_configured" && !service.required) {
    return { state: "optional", label: "Optional", icon: ServerCog };
  }
  if (!service.required) return { state: "waiting", label: "Unavailable", icon: Activity };
  return { state: "blocked", label: service.status === "not_configured" ? "Missing" : "Down", icon: XCircle };
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

function normalizeRuntimeInfrastructure(value: unknown): RuntimeInfrastructure {
  const row = asRow(value);
  const summary = asRow(row.summary);
  const services = asRowArray(row.services).map(normalizeRuntimeService).filter((service): service is RuntimeService => service !== null);
  const requiredServices = services.filter((service) => service.required);
  const optionalServices = services.filter((service) => !service.required);
  const requiredHealthy = requiredServices.length > 0
    ? requiredServices.every((service) => service.ok === true)
    : asBoolean(summary.requiredHealthy ?? summary.required_healthy);
  return {
    generatedAt: asString(row.generatedAt ?? row.generated_at, new Date().toISOString()),
    summary: {
      requiredHealthy,
      requiredCount: normalizeNumber(summary.requiredCount ?? summary.required_count, requiredServices.length, 0, 500),
      optionalConfigured: normalizeNumber(summary.optionalConfigured ?? summary.optional_configured, optionalServices.filter((service) => service.url || service.ok !== null).length, 0, 500),
      optionalHealthy: normalizeNumber(summary.optionalHealthy ?? summary.optional_healthy, optionalServices.filter((service) => service.ok === true).length, 0, 500),
    },
    services,
  };
}

function normalizeRuntimeService(value: unknown): RuntimeService | null {
  const row = asRow(value);
  const id = asString(row.id);
  if (!id) return null;
  const required = asBoolean(row.required);
  const status = normalizeRuntimeStatus(row.status);
  const ok = normalizeOptionalBoolean(row.ok);
  const strictChecks = normalizeRuntimeStrictChecks(row.details);
  const strictFailureSummary = runtimeStrictFailureSummary(strictChecks);
  return {
    id,
    label: asString(row.label ?? row.name, id),
    description: asString(row.description),
    category: normalizeRuntimeCategory(row.category),
    envKey: asString(row.envKey ?? row.env_key, "-"),
    url: asString(row.url) || null,
    required,
    remoteCapable: asBoolean(row.remoteCapable ?? row.remote_capable),
    status,
    ok,
    httpStatus: normalizeOptionalNumber(row.httpStatus ?? row.http_status),
    message: asString(row.message, ok === true ? "Healthy" : status === "not_configured" ? "Not configured" : "No probe message reported."),
    strictChecks,
    strictFailureSummary,
    checkedAt: asString(row.checkedAt ?? row.checked_at, new Date().toISOString()),
  };
}

function normalizeRuntimeStrictChecks(value: unknown): RuntimeStrictCheck[] {
  const details = asRow(value);
  const checks: RuntimeStrictCheck[] = [];
  for (const check of asRowArray(details.checks)) {
    const name = asString(check.name);
    if (!name) continue;
    checks.push({
      name,
      ok: asBoolean(check.ok),
      reason: asString(check.reason) || undefined,
    });
    if (checks.length >= 20) break;
  }
  return checks;
}

function runtimeStrictFailureSummary(checks: RuntimeStrictCheck[]): string | undefined {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return undefined;
  const parts = failed.slice(0, 3).map((check) => check.reason ? `${check.name}: ${check.reason}` : check.name);
  if (failed.length > parts.length) parts.push(`+${failed.length - parts.length} more`);
  return `Failed checks: ${parts.join("; ")}`;
}

function normalizeAdoptionHealth(value: unknown): AdoptionHealth {
  const row = asRow(value);
  const summary = asRow(row.summary);
  return {
    score: normalizeNumber(row.score, 0, 0, 100),
    summary: {
      ready: normalizeNumber(summary.ready, 0, 0, 500),
      warning: normalizeNumber(summary.warning, 0, 0, 500),
      blocked: normalizeNumber(summary.blocked, 0, 0, 500),
      connectedRuntimeCount: normalizeNumber(summary.connectedRuntimeCount ?? summary.connected_runtime_count, 0, 0, 500),
      readyProviderCount: normalizeNumber(summary.readyProviderCount ?? summary.ready_provider_count, 0, 0, 500),
      seededIntentCount: normalizeNumber(summary.seededIntentCount ?? summary.seeded_intent_count, 0, 0, 500),
    },
    blocked: asRowArray(row.blocked).map(normalizeHealthIssue).filter((item): item is NonNullable<AdoptionHealth["blocked"]>[number] => item !== null),
    warning: asRowArray(row.warning ?? row.warnings).map(normalizeHealthIssue).filter((item): item is NonNullable<AdoptionHealth["warning"]>[number] => item !== null),
  };
}

function normalizeHealthIssue(value: unknown): NonNullable<AdoptionHealth["blocked"]>[number] | null {
  const row = asRow(value);
  const id = asString(row.id);
  const label = asString(row.label ?? row.name, id || "Adoption check");
  if (!id && !label) return null;
  return {
    id: id || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    label,
    summary: asString(row.summary ?? row.message, "No summary reported."),
    fixCommand: asString(row.fixCommand ?? row.fix_command) || undefined,
    fixRoute: asString(row.fixRoute ?? row.fix_route) || undefined,
  };
}

function normalizeRuntimeStatus(value: unknown): RuntimeStatus {
  const status = asString(value).toLowerCase();
  if (status === "healthy" || status === "unhealthy" || status === "unreachable" || status === "not_configured") return status;
  return "unreachable";
}

function normalizeRuntimeCategory(value: unknown): RuntimeService["category"] {
  const category = asString(value).toLowerCase();
  if (category === "runtime" || category === "governance" || category === "core") return category;
  return "core";
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = asString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = normalizeOptionalNumber(value);
  if (parsed == null) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function parseJsonBody(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const row = asRow(parsed);
    return Object.keys(row).length > 0 ? row : null;
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
  const { data: adoption, error: adoptionError, isLoading: adoptionLoading, mutate: refreshAdoption } = useSWR(
    "adoption-health",
    adoptionHealth,
    { refreshInterval: 15000 },
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
    void refreshAdoption();
  };

  return (
    <div className="max-w-[1220px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
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
        <button type="button" className="btn-secondary" onClick={refreshAll} disabled={isLoading || runtimeLoading || adoptionLoading}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <div className="mb-4">
        <OperationsHero
          title={title}
          description={description}
          view={view}
          requiredHealthy={allRequiredHealthy}
          checkedAt={generatedAt}
        />
      </div>

      <AdoptionHealthScore health={adoption} error={adoptionError} loading={adoptionLoading} />

      {(error || runtimeError) && (
        <div className="mb-4">
          <ErrorState error={error?.message || runtimeError?.message || "Operations data failed to load"} />
        </div>
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
  const state: UiState = requiredHealthy ? "ready" : "waiting";
  return (
    <PageHeader
      eyebrow="Operations Center"
      icon={Icon}
      title={title}
      description={description}
      actions={
        <div className="flex flex-col items-end gap-1">
          <StatusChip state={state} label={requiredHealthy ? "Required healthy" : "Needs attention"} />
          <span className="text-xs text-slate-500">Checked {formatTime(checkedAt)}</span>
        </div>
      }
    />
  );
}

function AdoptionHealthScore({
  health,
  error,
  loading,
}: {
  health?: AdoptionHealth;
  error?: Error;
  loading: boolean;
}) {
  const score = health?.score ?? 0;
  const state: UiState = !health && loading ? "offline" : score >= 80 ? "ready" : score >= 55 ? "waiting" : "blocked";
  const scoreColor = state === "ready" ? "text-emerald-700" : state === "waiting" ? "text-amber-700" : state === "blocked" ? "text-red-700" : "text-slate-500";
  const attention = [...(health?.blocked ?? []), ...(health?.warning ?? [])].slice(0, 3);
  return (
    <section className={`${CARD} mb-4 p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <IconBadge icon={Gauge} state={state} size={20} />
          <div>
            <h2 className="text-base font-bold text-slate-900">Adoption Health Score</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Validates the first SDLC path: story planner, seeded workflow, Agent Studio seeds, Runtime Bridge, LLM provider, audit, and Copilot handoff.
            </p>
          </div>
        </div>
        <strong className={`text-3xl font-bold ${scoreColor}`}>{health ? `${score}%` : loading ? "..." : "Check"}</strong>
      </div>
      {error && <div className="mt-3"><ErrorState error={error.message} compact /></div>}
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
        <MetricTile label="Ready" value={health?.summary?.ready ?? 0} tone="emerald" />
        <MetricTile label="Warnings" value={health?.summary?.warning ?? 0} tone="amber" />
        <MetricTile label="Blocked" value={health?.summary?.blocked ?? 0} tone="red" />
        <MetricTile label="Runtime clients" value={health?.summary?.connectedRuntimeCount ?? 0} tone="blue" />
        <MetricTile label="LLM providers" value={health?.summary?.readyProviderCount ?? 0} tone="emerald" />
        <MetricTile label="Seeded intents" value={health?.summary?.seededIntentCount ?? 0} tone="slate" />
      </div>
      {attention.length > 0 && (
        <div className="mt-4 grid gap-2">
          {attention.map((item) => (
            <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5">
              <div className="min-w-0">
                <strong className="text-[13px] text-slate-900">{item.label}</strong>
                <span className="mt-0.5 block text-xs text-slate-500">{item.summary}</span>
              </div>
              {item.fixRoute ? (
                <Link href={item.fixRoute} className="btn-secondary text-xs">Fix</Link>
              ) : item.fixCommand ? (
                <code className="font-mono text-[11px] text-slate-600">{item.fixCommand}</code>
              ) : null}
            </div>
          ))}
        </div>
      )}
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
  const bridge = runtimeUiTone(runtimeBridge, loading);
  const requiredRuntimeDown = runtime?.services.filter((service) => service.required && service.ok === false).length ?? 0;
  const tiles: Array<{ href: string; icon: LucideIcon; title: string; value: string; description: string; state: UiState }> = [
    {
      href: "/operations/readiness",
      icon: Activity,
      title: "Readiness",
      value: `${coreHealthy}/${checks.length}`,
      description: "Required backend health, runtime checks, and failing endpoint details.",
      state: coreHealthy === checks.length ? "ready" : "waiting",
    },
    {
      href: "/operations/architecture",
      icon: Network,
      title: "Live App Map",
      value: "Topology",
      description: "Connected UI domains, APIs, Context Fabric, runtime bridge, MCP, and LLM paths.",
      state: "guarded",
    },
    {
      href: "/operations/setup",
      icon: Wrench,
      title: "Setup Center",
      value: runtime?.summary.requiredHealthy ? "Ready" : "Action",
      description: "Operator checklist, scripts, runtime dial-in, and environment targets.",
      state: runtime?.summary.requiredHealthy ? "ready" : "waiting",
    },
    {
      href: "/operations/trust",
      icon: ClipboardCheck,
      title: "Trust Evidence",
      value: requiredRuntimeDown ? `${requiredRuntimeDown} gaps` : "Current",
      description: "Health-backed evidence for identity, prompts, workflows, runtime, and governance.",
      state: requiredRuntimeDown ? "blocked" : "ready",
    },
  ];

  return (
    <>
      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.href} href={tile.href} className={`${CARD} block p-4 no-underline transition hover:border-slate-300 hover:shadow-md`}>
              <div className="flex items-start justify-between gap-3">
                <IconBadge icon={Icon} state={tile.state} size={20} />
                <strong className="text-lg text-slate-900">{tile.value}</strong>
              </div>
              <h2 className="mb-1.5 mt-3.5 text-base font-semibold text-slate-900">{tile.title}</h2>
              <p className="text-[13px] leading-5 text-slate-500">{tile.description}</p>
            </Link>
          );
        })}
      </section>

      <section className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <article className={`${CARD} p-4`}>
          <SectionTitle icon={ListChecks} title="Attention Queue" subtitle="Required checks that need operator focus." />
          <div className="mt-3 grid gap-2.5">
            {checks.filter((item) => item.result && !item.result.ok).map((item) => (
              <HealthRow key={item.path} item={item} loading={loading} compact />
            ))}
            {runtime?.services.filter((service) => service.required && service.ok === false).map((service) => (
              <RuntimeRow key={service.id} service={service} compact />
            ))}
            {!checks.some((item) => item.result && !item.result.ok) && !runtime?.services.some((service) => service.required && service.ok === false) && (
              <EmptyState icon={CheckCircle2} title="No required blockers" hint="Core APIs and required runtime checks are currently green." />
            )}
          </div>
        </article>

        <article className={`${CARD} p-4`}>
          <SectionTitle icon={CloudCog} title="Runtime Bridge" subtitle="MCP and LLM should dial into Context Fabric." />
          <div className="my-3.5 flex items-center gap-3">
            <IconBadge icon={bridge.icon} state={bridge.state} size={20} />
            <div>
              <div className="font-bold text-slate-900">{runtimeBridge?.label ?? "Runtime Bridge"}</div>
              <StatusChip state={bridge.state} label={bridge.label} />
            </div>
          </div>
          <p className="text-[13px] leading-6 text-slate-600">
            {runtimeBridge?.message ?? "Waiting for Context Fabric runtime bridge status."}
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
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
      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
        <MetricTile label="Core services" value={`${healthy}/${checks.length}`} tone={healthy === checks.length ? "emerald" : "amber"} icon={ServerCog} />
        <MetricTile label="Runtime required" value={runtime?.summary.requiredHealthy ? "Healthy" : runtime ? "Needs attention" : "..."} tone={runtime?.summary.requiredHealthy ? "emerald" : "amber"} icon={Network} />
        <MetricTile label="Optional runtimes" value={runtime ? `${runtime.summary.optionalHealthy}/${runtime.summary.optionalConfigured}` : "..."} tone="blue" icon={CloudCog} />
        <MetricTile label="Readiness score" value={`${percent}%`} tone={percent === 100 ? "emerald" : "amber"} icon={Gauge} />
      </section>

      <section className={`${CARD} mb-4 p-4`}>
        <SectionTitle icon={Activity} title="Core Platform Services" subtitle="Live endpoint checks used by the unified web shell." />
        <div className="my-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {checks.map((item) => <HealthCard key={item.path} item={item} loading={loading} />)}
        </div>
      </section>

      <section className={`${CARD} p-4`}>
        <SectionTitle icon={CloudCog} title="Runtime Infrastructure" subtitle="Required fabric services and optional dial-in/debug services." />
        <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
          {Object.entries(servicesByCategory).map(([category, services]) => (
            <article key={category} className="rounded-lg border border-slate-200 p-3.5">
              <h3 className="mb-2.5 text-sm font-semibold capitalize text-slate-900">{category}</h3>
              <div className="grid gap-2.5">
                {services.map((service) => <RuntimeRow key={service.id} service={service} compact />)}
              </div>
            </article>
          ))}
          {!runtime?.services?.length && <EmptyState icon={Activity} title="Runtime status loading" hint="Waiting for runtime infrastructure telemetry." />}
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
      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-3">
        <InfoCard icon={Route} state="guarded" title="Single web entry" value=":5180" body="Platform Web owns the route tree and proxies backend calls from one UI container." />
        <InfoCard icon={Database} state="ready" title="Context Fabric" value="runtime hub" body="Workflow, prompt, memory, and runtime bridge traffic converge through Context Fabric." />
        <InfoCard icon={CloudCog} state={runtimeBridge?.ok ? "ready" : "waiting"} title="Runtime dial-in" value={runtimeUiTone(runtimeBridge).label} body={runtimeBridge?.message ?? "Runtime Bridge status is loading."} />
        <InfoCard icon={TerminalSquare} state="offline" title="Debug HTTP" value={runtime ? `${runtime.summary.optionalConfigured} configured` : "..."} body="MCP and LLM direct URLs are diagnostics or explicit fallback paths." />
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
      <section className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
        <article className={`${CARD} p-4`}>
          <SectionTitle icon={ListChecks} title="Setup Checklist" subtitle="Bring the platform from local stack to runtime-ready state." />
          <div className="mt-3.5 grid gap-2.5">
            {steps.map((step, index) => (
              <Link
                key={step.title}
                href={step.href}
                className={`${CARD} grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 p-3.5 no-underline shadow-none transition hover:border-slate-300 hover:shadow-sm`}
              >
                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${step.done ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                  {step.done ? <CheckCircle2 size={18} /> : <span className="font-bold">{index + 1}</span>}
                </span>
                <span className="min-w-0">
                  <strong className="text-slate-900">{step.title}</strong>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">{step.detail}</span>
                </span>
                <StatusChip state={step.done ? "ready" : "waiting"} label={loading && !step.done ? "Checking" : step.done ? "Done" : "Open"} />
              </Link>
            ))}
          </div>
        </article>

        <article className={`${CARD} p-4`}>
          <SectionTitle icon={TerminalSquare} title="Operator Commands" subtitle="Scripts for Docker, bare metal apps, and remote runtimes." />
          <div className="mt-3.5 grid gap-2.5">
            {setupCommands.map((item) => (
              <CommandBlock key={item.command} label={item.label} command={item.command} />
            ))}
          </div>
        </article>
      </section>

      <section className={`${CARD} p-4`}>
        <SectionTitle icon={KeyRound} title="Environment Targets" subtitle="Configured service URLs and the env vars that control them." />
        <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {(runtime?.services ?? []).map((service) => <RuntimeConfigCard key={service.id} service={service} />)}
          {!runtime?.services?.length && <EmptyState icon={ServerCog} title="Runtime config loading" hint="Waiting for runtime infrastructure telemetry." />}
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
      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-3">
        {groups.map((group) => <EvidenceGroupCard key={group.title} group={group} />)}
      </section>

      <section className={`${CARD} p-4`}>
        <SectionTitle icon={ClipboardCheck} title="Evidence Records" subtitle="Rendered health payloads and runtime probe messages." />
        <div className="mt-3.5 grid gap-2.5">
          {evidenceRows.map((row) => <EvidenceRecord key={`${row.kind}-${row.label}`} row={row} />)}
        </div>
      </section>
    </>
  );
}

function IconBadge({ icon: Icon, state, size = 17 }: { icon: LucideIcon; state: UiState; size?: number }) {
  return (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TINT[state]}`}>
      <Icon size={size} />
    </span>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
      {children}
    </span>
  );
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
        <Icon size={17} />
      </span>
      <div>
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-slate-500">{subtitle}</p>
      </div>
    </div>
  );
}

function PayloadPreview({ body, fallback, compact = false }: { body?: string; fallback: string; compact?: boolean }) {
  const parsed = parseJsonBody(body);
  if (parsed) {
    const entries = Object.entries(parsed).slice(0, compact ? 3 : 5);
    return (
      <div className="mt-2 grid gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-[11px]">
            <span className="font-mono text-slate-400">{key}</span>
            <strong className="min-w-0 truncate text-slate-700">{shortValue(value)}</strong>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-500">
      {body || fallback}
    </div>
  );
}

function InfoCard({ icon: Icon, title, value, body, state }: { icon: LucideIcon; title: string; value: string; body: string; state: UiState }) {
  const valueColor = state === "ready" ? "text-emerald-700" : state === "waiting" ? "text-amber-700" : state === "blocked" ? "text-red-700" : state === "guarded" ? "text-blue-700" : "text-slate-500";
  return (
    <article className={`${CARD} p-4`}>
      <div className="flex items-start justify-between gap-2.5">
        <IconBadge icon={Icon} state={state} size={18} />
        <strong className={valueColor}>{value}</strong>
      </div>
      <h2 className="mb-1.5 mt-3 text-[15px] font-semibold text-slate-900">{title}</h2>
      <p className="text-xs leading-5 text-slate-500">{body}</p>
    </article>
  );
}

function HealthCard({ item, loading }: { item: CheckResult; loading: boolean }) {
  const tone = checkUiTone(item.result, loading);
  return (
    <article className={`${CARD} p-3.5`}>
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <IconBadge icon={tone.icon} state={tone.state} />
          <div className="min-w-0">
            <div className="font-bold text-slate-900">{item.label}</div>
            <div className="mt-0.5 text-xs text-slate-500">{item.path}</div>
          </div>
        </div>
        <StatusChip state={tone.state} label={tone.label} />
      </div>
      <p className="mb-2.5 text-xs leading-5 text-slate-500">{item.description}</p>
      <PayloadPreview body={item.result?.body} fallback={item.result ? `${item.result.status}` : "Loading..."} />
    </article>
  );
}

function HealthRow({ item, loading, compact = false }: { item: CheckResult; loading: boolean; compact?: boolean }) {
  const tone = checkUiTone(item.result, loading);
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border border-slate-200 ${compact ? "p-2.5" : "p-3"}`}>
      <IconBadge icon={tone.icon} state={tone.state} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2.5">
          <strong className="text-slate-900">{item.label}</strong>
          <StatusChip state={tone.state} label={tone.label} />
        </div>
        <div className="mt-0.5 text-xs text-slate-500">{item.path}</div>
        {!compact && <PayloadPreview body={item.result?.body} fallback="Waiting for response" />}
      </div>
    </div>
  );
}

function RuntimeRow({ service, compact = false }: { service: RuntimeService; compact?: boolean }) {
  const tone = runtimeUiTone(service);
  const Icon = serviceIcon(service);
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border border-slate-200 ${compact ? "p-2.5" : "p-3"}`}>
      <IconBadge icon={Icon} state={tone.state} size={16} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2.5">
          <strong className="text-slate-900">{service.label}</strong>
          <StatusChip state={tone.state} label={tone.label} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Pill>{service.required ? "required" : "optional"}</Pill>
          <Pill>{service.envKey}</Pill>
          {service.remoteCapable && <Pill>remote capable</Pill>}
        </div>
        {service.strictFailureSummary && (
          <div className="mt-2 rounded-md border border-red-100 bg-red-50 px-2 py-1.5 text-[11px] leading-5 text-red-800">
            {service.strictFailureSummary}
          </div>
        )}
        {!compact && <p className="mt-2 text-xs leading-5 text-slate-500">{service.message}</p>}
      </div>
    </div>
  );
}

function RuntimeConfigCard({ service }: { service: RuntimeService }) {
  const tone = runtimeUiTone(service);
  return (
    <article className="rounded-lg border border-slate-200 p-3.5">
      <div className="mb-2.5 flex items-start justify-between gap-2.5">
        <div>
          <strong className="text-slate-900">{service.label}</strong>
          <div className="mt-0.5 text-xs text-slate-500">{service.envKey}</div>
        </div>
        <StatusChip state={tone.state} label={tone.label} />
      </div>
      <div className="mb-2.5 text-xs leading-6 text-slate-500">{service.description}</div>
      <code className="block overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-[11px] text-slate-700">
        {service.url ?? "not configured"}
      </code>
      {service.strictFailureSummary && (
        <div className="mt-2 rounded-md border border-red-100 bg-red-50 px-2.5 py-2 text-[11px] leading-5 text-red-800">
          {service.strictFailureSummary}
        </div>
      )}
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
  const state: UiState = hardFailures ? "blocked" : live ? "ready" : "offline";
  const label = hardFailures
    ? `${hardFailures} gap${hardFailures === 1 ? "" : "s"}`
    : live
      ? `${live}/${group.sources.length} live`
      : "Pending";
  const Icon = group.icon;
  return (
    <Link href={group.route} className={`${CARD} block p-4 no-underline transition hover:border-slate-300 hover:shadow-md`}>
      <div className="flex items-start justify-between gap-3">
        <IconBadge icon={Icon} state={state} size={19} />
        <StatusChip state={state} label={label} />
      </div>
      <h2 className="mb-2.5 mt-3 text-[15px] font-semibold text-slate-900">{group.title}</h2>
      <div className="grid gap-1.5">
        {group.sources.map((source, index) => (
          <div key={`${source.kind}-${source.label}-${index}`} className="flex justify-between gap-2 text-xs text-slate-500">
            <span>{source.label}</span>
            <strong className={source.ok === true ? "text-emerald-700" : source.ok === false && source.required ? "text-red-700" : "text-slate-500"}>{source.status}</strong>
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
  const tone = checkUiTone(item?.result ?? null, loading);
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
  const tone = runtimeUiTone(service, loading);
  return {
    label: service?.label ?? "Runtime service",
    kind: "runtime",
    status: tone.label,
    ok: service?.ok ?? null,
    required: service?.required ?? false,
    endpoint: service?.url ?? service?.envKey ?? "not configured",
    message: service?.strictFailureSummary ?? service?.message ?? "Waiting for runtime probe.",
    checkedAt: service?.checkedAt,
  };
}

function EvidenceRecord({ row }: { row: EvidenceSource }) {
  const state: UiState = row.ok === true ? "ready" : row.ok === false && row.required ? "blocked" : "offline";
  return (
    <article className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-start gap-3 rounded-lg border border-slate-200 p-3">
      <div>
        <strong className="text-slate-900">{row.label}</strong>
        <div className="mt-1 text-xs text-slate-500">{row.kind}</div>
      </div>
      <div className="min-w-0">
        <div className="break-words text-xs text-slate-500">{row.endpoint}</div>
        <PayloadPreview body={row.body} fallback={row.message} compact />
      </div>
      <div className="grid justify-items-end gap-1.5">
        <StatusChip state={state} label={row.status} />
        <span className="text-[11px] text-slate-500">{formatTime(row.checkedAt)}</span>
      </div>
    </article>
  );
}

function groupRuntimeServices(services: RuntimeService[]) {
  return services.reduce<Record<string, RuntimeService[]>>((acc, service) => {
    if (!acc[service.category]) acc[service.category] = [];
    acc[service.category].push(service);
    return acc;
  }, {});
}
