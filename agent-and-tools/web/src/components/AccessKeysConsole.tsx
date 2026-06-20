"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  CloudCog,
  Copy,
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
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

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
const groupMeta: Record<AccessKeyGroup, { title: string; description: string; icon: typeof ShieldCheck }> = {
  identity: {
    title: "Identity and Session Boundary",
    description: "Bootstrap credentials, token signing, and tenant scoping that protect the platform entry points.",
    icon: Fingerprint,
  },
  platform: {
    title: "Platform Service Credentials",
    description: "Server-side tokens used by the unified web app and internal services to call backend APIs.",
    icon: ServerCog,
  },
  runtime: {
    title: "Runtime Dial-In",
    description: "Credentials for MCP and LLM Gateway services that may run outside the main platform stack.",
    icon: CloudCog,
  },
  providers: {
    title: "External Provider Credentials",
    description: "Provider keys for GitHub, Copilot, and BYOK model execution. These should live at the runtime boundary.",
    icon: Globe2,
  },
};

const commands = [
  { label: "Audit deployment env", command: "./singularity.sh config audit" },
  { label: "Rotate local secrets", command: "./singularity.sh config rotate-secrets" },
  { label: "Prepare production config", command: "./singularity.sh config prepare-prod" },
  { label: "Restart unified web", command: "./singularity.sh up platform-web" },
];

async function fetchAccessKeys(): Promise<AccessKeysResponse> {
  const res = await fetch(apiPath("/api/platform-access-keys"), {
    cache: "no-store",
    headers: authHeaders(),
  });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return parsed as AccessKeysResponse;
}

function statusTone(status: AccessKeyStatus, severity: AccessKeySeverity) {
  if (severity === "error" || status === "missing") {
    return { label: status === "missing" ? "Missing" : statusLabel(status), fg: "#991b1b", bg: "#fef2f2", border: "#fecaca", icon: ShieldAlert };
  }
  if (severity === "warn" || status === "default" || status === "weak") {
    return { label: statusLabel(status), fg: "#92400e", bg: "#fffbeb", border: "#fde68a", icon: AlertTriangle };
  }
  if (status === "ready") {
    return { label: "Ready", fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", icon: CheckCircle2 };
  }
  return { label: statusLabel(status), fg: "#475569", bg: "#f8fafc", border: "#cbd5e1", icon: EyeOff };
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
    <div style={{ maxWidth: 1180 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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

      <section className="card" style={{ padding: 24, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <span style={iconBox("#047857", "#ecfdf5")}>
            <LockKeyhole size={24} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Operations</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Access Keys and Tokens</h1>
            <p style={{ color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6, margin: 0, maxWidth: 860 }}>
              Review credential readiness by boundary: identity, platform services, dial-in runtimes, and external providers.
              Raw secret values are never sent to the browser.
            </p>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 18 }}>
        <Metric label="Configured" value={data ? `${data.summary.configured}/${data.summary.total}` : "..."} tone="#047857" />
        <Metric label="Visible to Platform Web" value={data ? visibleRows : "..."} tone="#2563eb" />
        <Metric label="Needs rotation" value={data ? needsRotation : "..."} tone={needsRotation ? "#b45309" : "#047857"} />
        <Metric label="Missing required" value={data ? data.summary.missingRequired : "..."} tone={data?.summary.missingRequired ? "#b91c1c" : "#047857"} />
        <Metric label="Production blockers" value={data ? data.summary.productionBlockers : "..."} tone={data?.summary.productionBlockers ? "#b91c1c" : "#047857"} />
      </section>

      <section className="card" style={{ padding: 18, boxShadow: "none", marginBottom: 18, borderColor: data?.environment.productionClass ? "#fde68a" : undefined }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 850 }}>Environment guard</div>
            <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "5px 0 0" }}>
              {data?.environment.productionClass
                ? `Production-class checks are active through ${data.environment.productionSignal}.`
                : "Local/development checks are active. Development defaults are warnings here and blockers in production-class deployments."}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Pill>{data?.environment.appEnv ? `APP_ENV=${data.environment.appEnv}` : "APP_ENV unset"}</Pill>
            <Pill>{data?.environment.rawSecretsReturned === false ? "No raw secrets" : "Secret payload blocked"}</Pill>
            <Pill>{data ? `Checked ${formatTime(data.generatedAt)}` : "Waiting for check"}</Pill>
          </div>
        </div>
      </section>

      {error && (
        <section className="card" style={{ padding: 16, borderColor: "#fecaca", background: "#fef2f2", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#991b1b", fontWeight: 800 }}>
            <ShieldAlert size={17} />
            Could not load access key classifications
          </div>
          <p style={{ margin: "8px 0 0", color: "#7f1d1d", fontSize: 13, lineHeight: 1.5 }}>
            {error.message}. Sign in through Identity, then refresh this page.
          </p>
        </section>
      )}

      {isLoading && !data && !error && (
        <section className="card" style={{ padding: 16, marginBottom: 18, color: "var(--color-outline)" }}>
          Loading access key classifications...
        </section>
      )}

      {groupOrder.map((group) => {
        const rows = keys.filter((key) => key.group === group);
        const meta = groupMeta[group];
        const Icon = meta.icon;
        return (
          <section key={group} style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <span style={iconBox(group === "providers" ? "#2563eb" : group === "runtime" ? "#7c3aed" : "#047857", "#f8fafc")}>
                  <Icon size={19} />
                </span>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 850, margin: 0 }}>{meta.title}</h2>
                  <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "4px 0 0" }}>{meta.description}</p>
                </div>
              </div>
              <span className="badge">{rows.length || (data ? 0 : "...")} keys</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
              {rows.map((row) => <AccessKeyCard key={row.id} row={row} />)}
              {!rows.length && (
                <article className="card" style={{ padding: 16, boxShadow: "none", color: "var(--color-outline)" }}>
                  {data ? "No access key rows in this group." : "Waiting for access key metadata..."}
                </article>
              )}
            </div>
          </section>
        );
      })}

      <section className="card" style={{ padding: 18, boxShadow: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <TerminalSquare size={18} color="#047857" />
          <div>
            <div style={{ fontWeight: 850 }}>Operator Commands</div>
            <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "3px 0 0" }}>
              Use host-side config commands for full-stack secret audits and rotation. This browser page only shows safe classifications.
            </p>
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {commands.map((item) => <CommandRow key={item.command} label={item.label} command={item.command} />)}
        </div>
      </section>
    </div>
  );
}

function AccessKeyCard({ row }: { row: AccessKeyRow }) {
  const tone = statusTone(row.status, row.severity);
  const Icon = row.kind === "scope" ? Clipboard : row.group === "providers" ? Globe2 : row.kind === "password" ? KeyRound : ShieldCheck;
  const StatusIcon = tone.icon;

  return (
    <article className="card" style={{ padding: 16, boxShadow: "none", borderColor: tone.border }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
          <span style={iconBox(tone.fg, tone.bg)}>
            <Icon size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 850, overflowWrap: "anywhere" }}>{row.label}</div>
            <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 3 }}>{row.owner}</div>
          </div>
        </div>
        <span style={{ ...pillStyle(tone.fg, tone.bg, tone.border), whiteSpace: "nowrap" }}>
          <StatusIcon size={12} />
          {tone.label}
        </span>
      </div>

      <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5, margin: "0 0 12px" }}>{row.description}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        <Pill>{row.requiredNow ? "required now" : row.required ? "required" : "optional"}</Pill>
        <Pill>{kindLabel(row.kind)}</Pill>
        {row.remoteCapable && <Pill>remote capable</Pill>}
        {!row.visibleToPlatformWeb && <Pill>runtime-owned</Pill>}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <Fact label="Env keys" value={row.envKeys.join(", ")} />
        <Fact label="Configured via" value={row.configuredEnvKey ?? (row.visibleToPlatformWeb ? "not configured" : "not injected into Platform Web")} />
        <Fact label="Scope" value={row.scope} />
        <Fact label="Used by" value={row.usedBy.join(", ")} />
        <Fact label="Rotation" value={row.rotation} />
      </div>

      <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, border: `1px solid ${tone.border}`, background: tone.bg, color: tone.fg, fontSize: 12, lineHeight: 1.45, fontWeight: 750 }}>
        {row.message}
      </div>
    </article>
  );
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return (
    <article className="card" style={{ padding: 16, boxShadow: "none" }}>
      <div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div>
      <div style={{ marginTop: 5, fontWeight: 850, color: tone ?? "var(--color-text)", fontSize: 20 }}>{valueText(value)}</div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, lineHeight: 1.45, fontWeight: 700, overflowWrap: "anywhere" }}>{valueText(value)}</div>
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="badge" style={{ textTransform: "none" }}>{children}</span>;
}

function CommandRow({ label, command }: { label: string; command: string }) {
  const copy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(command);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 210px) 1fr auto", gap: 10, alignItems: "center", padding: 10, border: "1px solid var(--color-border)", borderRadius: 8, background: "#fff" }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>{label}</div>
      <code style={{ fontSize: 12, overflowWrap: "anywhere" }}>{command}</code>
      <button type="button" className="btn-secondary text-xs" onClick={copy} aria-label={`Copy ${label}`}>
        <Copy size={13} />
      </button>
    </div>
  );
}

function iconBox(color: string, background: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: 8,
    color,
    background,
    flex: "0 0 auto",
  };
}

function pillStyle(color: string, background: string, border: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: `1px solid ${border}`,
    color,
    background,
    borderRadius: 999,
    padding: "4px 9px",
    fontSize: 11,
    fontWeight: 850,
    textTransform: "uppercase",
  };
}
