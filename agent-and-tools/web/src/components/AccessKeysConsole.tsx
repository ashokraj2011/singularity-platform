"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  CloudCog,
  EyeOff,
  Fingerprint,
  Globe2,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiPath, assertValidApiResponse, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import {
  CommandBlock,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  StatusChip,
  type UiState,
} from "@/components/ui/primitives";

type AccessKeyStatus = "ready" | "missing" | "default" | "weak" | "optional" | "not_visible";
type AccessKeySeverity = "ok" | "warn" | "error" | "info";
type AccessKeyKind = "password" | "service_token" | "bearer_token" | "api_key" | "provider_token" | "scope";
type AccessKeyGroup = "identity" | "platform" | "runtime" | "providers";

type AccessKeyRow = {
  id: string;
  label: string;
  description: string;
  group: AccessKeyGroup;
  owner: string;
  kind: AccessKeyKind;
  envKeys: string[];
  scope: string;
  usedBy: string[];
  rotation: string;
  required: boolean;
  productionRequired?: boolean;
  remoteCapable: boolean;
  visibleToPlatformWeb: boolean;
  configured: boolean;
  configuredEnvKey: string | null;
  requiredNow: boolean;
  status: AccessKeyStatus;
  severity: AccessKeySeverity;
  message: string;
};

type AccessKeysResponse = {
  generatedAt: string;
  environment: {
    productionClass: boolean;
    productionSignal: string | null;
    appEnv: string | null;
    singularityEnv: string | null;
    rawSecretsReturned: false;
  };
  summary: {
    total: number;
    configured: number;
    configuredVisibleToPlatformWeb: number;
    missingRequired: number;
    optionalNotConfigured: number;
    defaultOrWeak: number;
    notVisible: number;
    productionBlockers: number;
    providerCredentialsPresent: boolean;
  };
  keys: AccessKeyRow[];
};

const groupOrder: AccessKeyGroup[] = ["identity", "platform", "runtime", "providers"];
const groupMeta: Record<AccessKeyGroup, { title: string; description: string; icon: LucideIcon; state: UiState }> = {
  identity: {
    title: "Identity and Session Boundary",
    description: "Bootstrap credentials, token signing, and tenant scoping that protect the platform entry points.",
    icon: Fingerprint,
    state: "ready",
  },
  platform: {
    title: "Platform Service Credentials",
    description: "Server-side tokens used by the unified web app and internal services to call backend APIs.",
    icon: ServerCog,
    state: "ready",
  },
  runtime: {
    title: "Runtime Dial-In",
    description: "Credentials for MCP and LLM Gateway services that may run outside the main platform stack.",
    icon: CloudCog,
    state: "guarded",
  },
  providers: {
    title: "External Provider Credentials",
    description: "Provider keys for GitHub, Copilot, and BYOK model execution. These should live at the runtime boundary.",
    icon: Globe2,
    state: "guarded",
  },
};

const commands = [
  { label: "Audit deployment env", command: "./singularity.sh config audit" },
  { label: "Rotate local secrets", command: "./singularity.sh config rotate-secrets" },
  { label: "Prepare production config", command: "./singularity.sh config prepare-prod" },
  { label: "Restart unified web", command: "./singularity.sh up platform-web" },
];

// Tailwind tints keyed by the shared UiState (icon badges + the per-key message box).
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
const BOX: Record<UiState, string> = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-800",
  waiting: "border-amber-200 bg-amber-50 text-amber-800",
  blocked: "border-red-200 bg-red-50 text-red-800",
  offline: "border-slate-200 bg-slate-50 text-slate-600",
  guarded: "border-blue-200 bg-blue-50 text-blue-800",
  optional: "border-slate-200 bg-slate-50 text-slate-500",
  "needs-auth": "border-blue-200 bg-blue-50 text-blue-800",
  "needs-runtime": "border-violet-200 bg-violet-50 text-violet-800",
  degraded: "border-amber-200 bg-amber-50 text-amber-800",
};

async function fetchAccessKeys(): Promise<AccessKeysResponse> {
  const res = await fetch(apiPath("/api/platform-access-keys"), {
    cache: "no-store",
    headers: authHeaders(),
  });
  const { raw, parsed, parseError } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  assertValidApiResponse("/api/platform-access-keys", raw, parseError);
  return parsed as AccessKeysResponse;
}

// Maps the key's status/severity onto the shared StatusChip vocabulary.
function statusUiTone(status: AccessKeyStatus, severity: AccessKeySeverity): { state: UiState; label: string; icon: LucideIcon } {
  if (severity === "error" || status === "missing") {
    return { state: "blocked", label: status === "missing" ? "Missing" : statusLabel(status), icon: ShieldAlert };
  }
  if (severity === "warn" || status === "default" || status === "weak") {
    return { state: "waiting", label: statusLabel(status), icon: AlertTriangle };
  }
  if (status === "ready") {
    return { state: "ready", label: "Ready", icon: CheckCircle2 };
  }
  if (status === "optional") {
    return { state: "optional", label: statusLabel(status), icon: EyeOff };
  }
  return { state: "offline", label: statusLabel(status), icon: EyeOff };
}

function statusLabel(status: AccessKeyStatus): string {
  return status.replace("_", " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function kindLabel(kind: AccessKeyKind): string {
  return kind.replace("_", " ");
}

function formatTime(value?: string) {
  if (!value) return "not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not checked";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export function AccessKeysConsole() {
  const { data, error, isLoading, mutate } = useSWR("platform-access-keys", fetchAccessKeys, { refreshInterval: 15000 });
  const keys = data?.keys ?? [];
  const needsRotation = data?.summary.defaultOrWeak ?? 0;
  const visibleRows = data?.summary.configuredVisibleToPlatformWeb ?? 0;

  return (
    <div className="max-w-[1180px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2.5">
          <Link href="/operations" className="btn-secondary">
            <ArrowLeft size={15} />
            Back to operations
          </Link>
          <Link href="/operations/architecture" className="btn-secondary">
            <Globe2 size={15} />
            Live app map
          </Link>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void mutate()} disabled={isLoading}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <div className="mb-4">
        <PageHeader
          eyebrow="Operations"
          icon={LockKeyhole}
          title="Access Keys and Tokens"
          description="Review credential readiness by boundary: identity, platform services, dial-in runtimes, and external providers. Raw secret values are never sent to the browser."
        />
      </div>

      <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
        <MetricTile label="Configured" value={data ? `${data.summary.configured}/${data.summary.total}` : "..."} tone="emerald" />
        <MetricTile label="Visible to Platform Web" value={data ? visibleRows : "..."} tone="blue" />
        <MetricTile label="Needs rotation" value={data ? needsRotation : "..."} tone={needsRotation ? "amber" : "emerald"} />
        <MetricTile label="Missing required" value={data ? data.summary.missingRequired : "..."} tone={data?.summary.missingRequired ? "red" : "emerald"} />
        <MetricTile label="Production blockers" value={data ? data.summary.productionBlockers : "..."} tone={data?.summary.productionBlockers ? "red" : "emerald"} />
      </section>

      <section className={`mb-4 rounded-xl border bg-white p-4 shadow-sm ${data?.environment.productionClass ? "border-amber-200" : "border-slate-200"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-bold text-slate-900">Environment guard</div>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">
              {data?.environment.productionClass
                ? `Production-class checks are active through ${data.environment.productionSignal}.`
                : "Local/development checks are active. Development defaults are warnings here and blockers in production-class deployments."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill>{data?.environment.appEnv ? `APP_ENV=${data.environment.appEnv}` : "APP_ENV unset"}</Pill>
            <Pill>{data?.environment.rawSecretsReturned === false ? "No raw secrets" : "Secret payload blocked"}</Pill>
            <Pill>{data ? `Checked ${formatTime(data.generatedAt)}` : "Waiting for check"}</Pill>
          </div>
        </div>
      </section>

      {error && (
        <div className="mb-4">
          <ErrorState error={`Could not load access key classifications: ${error.message}. Sign in through Identity, then refresh this page.`} />
        </div>
      )}

      {isLoading && !data && !error && (
        <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">
          Loading access key classifications...
        </section>
      )}

      {groupOrder.map((group) => {
        const rows = keys.filter((key) => key.group === group);
        const meta = groupMeta[group];
        const Icon = meta.icon;
        return (
          <section key={group} className="mb-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <IconBadge icon={Icon} state={meta.state} size={19} />
                <div>
                  <h2 className="text-base font-bold text-slate-900">{meta.title}</h2>
                  <p className="mt-1 text-[13px] leading-5 text-slate-500">{meta.description}</p>
                </div>
              </div>
              <Pill>{rows.length || (data ? 0 : "...")} keys</Pill>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-3">
              {rows.map((row) => <AccessKeyCard key={row.id} row={row} />)}
              {!rows.length && (
                <EmptyState
                  icon={KeyRound}
                  title={data ? "No access keys in this group" : "Loading…"}
                  hint={data ? "No access key rows are classified in this boundary." : "Waiting for access key metadata."}
                />
              )}
            </div>
          </section>
        );
      })}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2.5">
          <TerminalSquare size={18} className="text-emerald-600" />
          <div>
            <div className="font-bold text-slate-900">Operator Commands</div>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">
              Use host-side config commands for full-stack secret audits and rotation. This browser page only shows safe classifications.
            </p>
          </div>
        </div>
        <div className="grid gap-2.5">
          {commands.map((item) => <CommandBlock key={item.command} label={item.label} command={item.command} />)}
        </div>
      </section>
    </div>
  );
}

function AccessKeyCard({ row }: { row: AccessKeyRow }) {
  const tone = statusUiTone(row.status, row.severity);
  const Icon = row.kind === "scope" ? Clipboard : row.group === "providers" ? Globe2 : row.kind === "password" ? KeyRound : ShieldCheck;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <IconBadge icon={Icon} state={tone.state} />
          <div className="min-w-0">
            <div className="font-bold text-slate-900 [overflow-wrap:anywhere]">{row.label}</div>
            <div className="mt-0.5 text-xs text-slate-500">{row.owner}</div>
          </div>
        </div>
        <StatusChip state={tone.state} label={tone.label} />
      </div>

      <p className="mb-3 text-[13px] leading-5 text-slate-500">{row.description}</p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <Pill>{row.requiredNow ? "required now" : row.required ? "required" : "optional"}</Pill>
        <Pill>{kindLabel(row.kind)}</Pill>
        {row.remoteCapable && <Pill>remote capable</Pill>}
        {!row.visibleToPlatformWeb && <Pill>runtime-owned</Pill>}
      </div>

      <div className="grid gap-2.5">
        <Fact label="Env keys" value={row.envKeys.join(", ")} />
        <Fact label="Configured via" value={row.configuredEnvKey ?? (row.visibleToPlatformWeb ? "not configured" : "not injected into Platform Web")} />
        <Fact label="Scope" value={row.scope} />
        <Fact label="Used by" value={row.usedBy.join(", ")} />
        <Fact label="Rotation" value={row.rotation} />
      </div>

      <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs font-semibold leading-5 ${BOX[tone.state]}`}>
        {row.message}
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="text-xs font-semibold leading-5 text-slate-800 [overflow-wrap:anywhere]">{valueText(value)}</div>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
      {children}
    </span>
  );
}

function IconBadge({ icon: Icon, state, size = 17 }: { icon: LucideIcon; state: UiState; size?: number }) {
  return (
    <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${TINT[state]}`}>
      <Icon size={size} />
    </span>
  );
}
