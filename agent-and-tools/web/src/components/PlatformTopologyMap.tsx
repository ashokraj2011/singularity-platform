"use client";

import Link from "next/link";
import useSWR from "swr";
import {
  Activity,
  Bot,
  Brain,
  CheckCircle2,
  Code2,
  Cpu,
  Database,
  GitBranch,
  Globe2,
  Hammer,
  Network,
  RefreshCw,
  Route,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
  Users,
  Workflow,
  XCircle,
} from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";

type TopologyStatus = "live" | "degraded" | "offline" | "unconfigured" | "unknown";
type NodeKind = "client" | "web" | "ui" | "api" | "runtime" | "governance" | "data";

type TopologyNode = {
  id: string;
  label: string;
  description: string;
  kind: NodeKind;
  group: string;
  envKey?: string;
  url: string | null;
  route?: string;
  required: boolean;
  remoteCapable: boolean;
  status: TopologyStatus;
  ok: boolean | null;
  httpStatus: number | null;
  message: string;
  checkedAt: string;
  position: { x: number; y: number };
};

type TopologyEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  protocol: string;
  required: boolean;
  status: TopologyStatus;
  message: string;
};

type Topology = {
  generatedAt: string;
  summary: {
    nodeCount: number;
    liveNodes: number;
    requiredHealthy: boolean;
    requiredDown: number;
    configuredOptional: number;
    liveEdges: number;
    edgeCount: number;
  };
  nodes: TopologyNode[];
  edges: TopologyEdge[];
};

async function fetchTopology(): Promise<Topology> {
  const res = await fetch(apiPath("/api/platform-topology"), {
    cache: "no-store",
    headers: authHeaders(),
  });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return parsed as Topology;
}

const iconByNode: Record<string, typeof Network> = {
  browser: Globe2,
  "platform-web": Network,
  "operations-ui": Activity,
  "agents-ui": Bot,
  "workflows-ui": Workflow,
  "workbench-ui": Route,
  "foundry-ui": Hammer,
  "identity-ui": Users,
  "llm-settings-ui": Cpu,
  "iam-service": ShieldCheck,
  "agent-service": Bot,
  "tool-service": TerminalSquare,
  "agent-runtime": Activity,
  "prompt-composer": Brain,
  "workgraph-api": GitBranch,
  "context-api": Database,
  "mcp-server": ServerCog,
  "llm-gateway": Cpu,
  "formal-verifier": CheckCircle2,
  "audit-governance": ShieldCheck,
};

function statusMeta(status: TopologyStatus, ok: boolean | null) {
  if (ok === true || status === "live") {
    return { label: "Live", tone: "#047857", bg: "#ecfdf5", border: "#a7f3d0", dot: "active" };
  }
  if (status === "unconfigured") {
    return { label: "Not configured", tone: "#64748b", bg: "#f8fafc", border: "#cbd5e1", dot: "" };
  }
  if (status === "degraded") {
    return { label: "Degraded", tone: "#92400e", bg: "#fffbeb", border: "#fde68a", dot: "warning" };
  }
  if (status === "unknown") {
    return { label: "Unknown", tone: "#475569", bg: "#f8fafc", border: "#cbd5e1", dot: "" };
  }
  return { label: "Offline", tone: "#991b1b", bg: "#fef2f2", border: "#fecaca", dot: "error" };
}

function edgeColor(status: TopologyStatus) {
  if (status === "live") return "#10b981";
  if (status === "degraded") return "#d97706";
  if (status === "unconfigured" || status === "unknown") return "#94a3b8";
  return "#dc2626";
}

function labelTime(value: string | undefined) {
  if (!value) return "not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not checked";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function PlatformTopologyMap() {
  const { data, error, isLoading, mutate } = useSWR("platform-topology", fetchTopology, { refreshInterval: 10000 });
  const nodes = data?.nodes ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const mapNodes = nodes.filter((node) => node.position);
  const criticalEdges = data?.edges.filter((edge) => edge.required) ?? [];
  const optionalEdges = data?.edges.filter((edge) => !edge.required) ?? [];

  return (
    <section className="topology-section">
      <div className="topology-header">
        <div>
          <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Live App Map</div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Platform topology and service connections</h2>
          <p style={{ color: "var(--color-outline)", fontSize: 13, lineHeight: 1.55, margin: "6px 0 0", maxWidth: 820 }}>
            One web app fans into domain routes, core APIs, workflow services, and remote-capable dial-in runtimes. Status refreshes every ten seconds from the platform health endpoints.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void mutate()} disabled={isLoading}>
          <RefreshCw size={15} />
          Refresh map
        </button>
      </div>

      <div className="topology-metrics">
        <Metric label="Nodes live" value={data ? `${data.summary.liveNodes}/${data.summary.nodeCount}` : "..."} ok={data?.summary.requiredHealthy ?? false} />
        <Metric label="Required APIs" value={data ? (data.summary.requiredHealthy ? "Healthy" : `${data.summary.requiredDown} down`) : "..."} ok={data?.summary.requiredHealthy ?? false} />
        <Metric label="Connections" value={data ? `${data.summary.liveEdges}/${data.summary.edgeCount} live` : "..."} ok={Boolean(data && data.summary.liveEdges === data.summary.edgeCount)} />
        <Metric label="Dial-in configured" value={data ? data.summary.configuredOptional : "..."} ok={Boolean(data && data.summary.configuredOptional > 0)} />
      </div>

      {error && (
        <div className="topology-error">
          <XCircle size={16} />
          {error.message}
        </div>
      )}

      <div className="topology-canvas" aria-label="Live platform topology map">
        <svg className="topology-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="topology-arrow-live" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#10b981" />
            </marker>
            <marker id="topology-arrow-muted" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8" />
            </marker>
            <marker id="topology-arrow-warn" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#d97706" />
            </marker>
            <marker id="topology-arrow-bad" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#dc2626" />
            </marker>
          </defs>
          {(data?.edges ?? []).map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            const color = edgeColor(edge.status);
            const marker = edge.status === "live" ? "url(#topology-arrow-live)" : edge.status === "degraded" ? "url(#topology-arrow-warn)" : edge.status === "offline" ? "url(#topology-arrow-bad)" : "url(#topology-arrow-muted)";
            return (
              <g key={edge.id}>
                <line
                  x1={source.position.x}
                  y1={source.position.y}
                  x2={target.position.x}
                  y2={target.position.y}
                  stroke={color}
                  strokeWidth={edge.required ? 0.42 : 0.28}
                  strokeDasharray={edge.required ? undefined : "1.2 1.2"}
                  opacity={edge.required ? 0.55 : 0.35}
                  markerEnd={marker}
                />
              </g>
            );
          })}
        </svg>

        {isLoading && !data && <div className="topology-loading">Loading live topology...</div>}

        {mapNodes.map((node) => (
          <TopologyNodeCard key={node.id} node={node} />
        ))}
      </div>

      <div className="topology-edge-summary">
        <ConnectionList title="Required Connections" edges={criticalEdges} nodeById={nodeById} />
        <ConnectionList title="Optional / Dial-In Connections" edges={optionalEdges} nodeById={nodeById} />
      </div>
    </section>
  );
}

function Metric({ label, value, ok }: { label: string; value: unknown; ok: boolean }) {
  return (
    <article className="topology-metric">
      <div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        {ok ? <CheckCircle2 size={16} color="#047857" /> : <Activity size={16} color="#64748b" />}
        <strong>{String(value)}</strong>
      </div>
    </article>
  );
}

function TopologyNodeCard({ node }: { node: TopologyNode }) {
  const Icon = iconByNode[node.id] ?? Network;
  const meta = statusMeta(node.status, node.ok);
  const body = (
    <article
      className="topology-node"
      style={{
        left: `${node.position.x}%`,
        top: `${node.position.y}%`,
        borderColor: meta.border,
      }}
    >
      <div className="topology-node-title">
        <span className="topology-node-icon" style={{ color: meta.tone, background: meta.bg }}>
          <Icon size={15} />
        </span>
        <span>{node.label}</span>
      </div>
      <div className="topology-node-meta">
        <span className={`status-dot ${meta.dot}`} />
        <span>{meta.label}</span>
        <span>{node.required ? "required" : "optional"}</span>
      </div>
      <p>{node.description}</p>
      <div className="topology-node-foot">
        <span>{node.route ?? node.envKey ?? node.group}</span>
        <span>{node.httpStatus ?? labelTime(node.checkedAt)}</span>
      </div>
    </article>
  );

  if (node.route) {
    return (
      <Link href={node.route} className="topology-node-link" title={`${node.label}: ${node.message}`}>
        {body}
      </Link>
    );
  }
  return (
    <div title={`${node.label}: ${node.message}`}>
      {body}
    </div>
  );
}

function ConnectionList({
  title,
  edges,
  nodeById,
}: {
  title: string;
  edges: TopologyEdge[];
  nodeById: Map<string, TopologyNode>;
}) {
  return (
    <article className="topology-connections">
      <h3>{title}</h3>
      <div>
        {edges.map((edge) => {
          const meta = statusMeta(edge.status, edge.status === "live" ? true : edge.status === "offline" ? false : null);
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          return (
            <div key={edge.id} className="topology-connection-row">
              <div>
                <strong>{source?.label ?? edge.source}</strong>
                <span> to </span>
                <strong>{target?.label ?? edge.target}</strong>
                <div>{edge.label} · {edge.protocol}</div>
              </div>
              <span className="badge" style={{ color: meta.tone, background: meta.bg, borderColor: meta.border }}>{meta.label}</span>
            </div>
          );
        })}
        {edges.length === 0 && <div style={{ color: "var(--color-outline)", fontSize: 13 }}>No connections reported.</div>}
      </div>
    </article>
  );
}
