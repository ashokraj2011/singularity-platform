"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, CheckCircle2, FileJson, GitBranch, RefreshCw, Route, Search } from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";

type WorkflowTemplateStatus = {
  state?: "valid" | "invalid" | string | null;
  reason?: string | null;
  message?: string | null;
  template?: {
    id?: string | null;
    name?: string | null;
    workflowTypeKey?: string | null;
    capabilityId?: string | null;
  } | null;
};

type RoutingPolicy = {
  id: string;
  capabilityId?: string | null;
  workItemTypeKey?: string | null;
  workflowTypeKey?: string | null;
  workflowId?: string | null;
  routingMode?: string | null;
  priority?: number | null;
  selector?: unknown;
  isActive?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  workflow?: {
    id?: string | null;
    name?: string | null;
    status?: string | null;
    profile?: string | null;
    workflowTypeKey?: string | null;
    capabilityId?: string | null;
  } | null;
  workflowTemplateStatus?: WorkflowTemplateStatus | null;
};

const filterOptions = [
  { label: "Active", query: "isActive=true" },
  { label: "Inactive", query: "isActive=false" },
  { label: "All", query: "" },
];

export function RoutingPoliciesConsole() {
  const [filter, setFilter] = useState(filterOptions[0].query);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const path = `/work-item-routing-policies${filter ? `?${filter}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR(path, workgraphFetch, { refreshInterval: 12000 });
  const policies = unwrapWorkgraphItems<RoutingPolicy>(data).filter((item) => matchesPolicy(item, query));
  const selected = useMemo(() => policies.find((item) => item.id === selectedId) ?? policies[0], [policies, selectedId]);
  const issueCount = policies.filter(hasTemplateIssue).length;
  const activeCount = policies.filter((item) => item.isActive !== false).length;

  return (
    <div style={{ maxWidth: 1360 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workflow diagnostics</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Routing Policies</h1>
            <p style={{ margin: 0, maxWidth: 820, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              Inspect WorkItem routing rules before they break a launch. Policies that point to missing, archived, workbench-profile, or wrong-capability workflow templates are called out with the exact reason from Workgraph.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-secondary" href="/work-items"><GitBranch size={15} /> Work Hub</Link>
            <button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={15} /> Refresh</button>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="Shown policies" value={policies.length} />
        <Metric label="Active" value={activeCount} tone="#2563eb" />
        <Metric label="Template issues" value={issueCount} tone={issueCount > 0 ? "#b91c1c" : "#15803d"} />
        <Metric label="Auto start" value={policies.filter((item) => item.routingMode === "AUTO_START").length} tone="#7c3aed" />
      </section>

      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6, background: "var(--color-surface-container)", padding: 4, borderRadius: 10 }}>
            {filterOptions.map((option) => (
              <Segment key={option.label} active={filter === option.query} onClick={() => setFilter(option.query)}>{option.label}</Segment>
            ))}
          </div>
          <div style={{ position: "relative", minWidth: 240, flex: "0 1 420px" }}>
            <Search size={14} style={{ position: "absolute", left: 11, top: 11, color: "var(--color-outline)" }} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by capability, type, mode, issue" style={inputStyle({ paddingLeft: 33 })} />
          </div>
        </div>
      </section>

      {error && <ErrorPanel error={error} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(310px, 0.95fr) minmax(380px, 1.05fr)", gap: 16, alignItems: "start" }}>
        <section style={{ display: "grid", gap: 10 }}>
          {isLoading && <EmptyPanel text="Loading routing policies..." />}
          {!isLoading && policies.length === 0 && <EmptyPanel text="No routing policies match this view." />}
          {policies.map((policy) => (
            <button
              key={policy.id}
              type="button"
              onClick={() => setSelectedId(policy.id)}
              className="card card-hover"
              style={{
                padding: 15,
                textAlign: "left",
                border: selected?.id === policy.id ? "1px solid rgba(54,135,39,0.42)" : undefined,
                background: selected?.id === policy.id ? "rgba(240,253,244,0.74)" : undefined,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <strong style={{ fontSize: 14, overflowWrap: "anywhere" }}>
                      {policy.workItemTypeKey ?? "GENERAL"} to {policy.workflowTypeKey ?? "GENERAL"}
                    </strong>
                    <Badge tone={policy.isActive === false ? "#64748b" : "#15803d"}>{policy.isActive === false ? "Inactive" : "Active"}</Badge>
                    {hasTemplateIssue(policy) && <Badge tone="#b91c1c">{policy.workflowTemplateStatus?.reason ?? "Template issue"}</Badge>}
                  </div>
                  <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>
                    {shortId(policy.capabilityId)} · {policy.routingMode ?? "MANUAL"} · priority {valueText(policy.priority)}
                  </p>
                </div>
                <Route size={18} color={hasTemplateIssue(policy) ? "#b91c1c" : "#64748b"} />
              </div>
            </button>
          ))}
        </section>

        <section className="card" style={{ padding: 18, minWidth: 0 }}>
          {selected ? <PolicyDetail policy={selected} /> : <EmptyPanel text="Select a routing policy to inspect template binding diagnostics." />}
        </section>
      </div>
    </div>
  );
}

function PolicyDetail({ policy }: { policy: RoutingPolicy }) {
  const status = policy.workflowTemplateStatus;
  const template = status?.template ?? policy.workflow;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>{policy.workItemTypeKey ?? "GENERAL"} routing</h2>
            <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>
              {policy.routingMode ?? "MANUAL"} policy for capability {shortId(policy.capabilityId)}.
            </p>
          </div>
          <Badge tone={policy.isActive === false ? "#64748b" : "#15803d"}>{policy.isActive === false ? "Inactive" : "Active"}</Badge>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <Fact label="Capability" value={policy.capabilityId} />
          <Fact label="WorkItem type" value={policy.workItemTypeKey} />
          <Fact label="Workflow type" value={policy.workflowTypeKey} />
          <Fact label="Routing mode" value={policy.routingMode} />
          <Fact label="Priority" value={policy.priority} />
          <Fact label="Updated" value={formatDate(policy.updatedAt ?? policy.createdAt)} />
        </div>
      </div>

      {policy.workflowId ? (
        <section style={{ border: `1px solid ${hasTemplateIssue(policy) ? "rgba(185,28,28,0.24)" : "rgba(22,101,52,0.2)"}`, borderRadius: 8, padding: 12, background: hasTemplateIssue(policy) ? "rgba(254,242,242,0.72)" : "rgba(240,253,244,0.72)", color: hasTemplateIssue(policy) ? "#7f1d1d" : "#166534" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 850 }}>
            {hasTemplateIssue(policy) ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
            {hasTemplateIssue(policy) ? "Workflow template binding needs attention" : "Workflow template binding is startable"}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.55 }}>
            {status?.message ?? "Workgraph did not return a template diagnostic for this binding."}
          </p>
        </section>
      ) : (
        <section style={{ border: "1px solid rgba(100,116,139,0.24)", borderRadius: 8, padding: 12, background: "rgba(248,250,252,0.86)", color: "#475569" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 850 }}>
            <Route size={15} />
            Manual template selection
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.55 }}>
            This policy has no fixed workflow template. Workgraph will route the WorkItem but launch requires a template to be selected later.
          </p>
        </section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <Fact label="Workflow id" value={policy.workflowId} />
        <Fact label="Workflow name" value={template?.name} />
        <Fact label="Workflow capability" value={template?.capabilityId} />
        <Fact label="Template state" value={status?.state ?? (policy.workflowId ? "unknown" : "not bound")} />
      </div>

      <JsonPanel title="Selector" value={policy.selector} />
      <JsonPanel title="Raw diagnostic" value={policy.workflowTemplateStatus ?? { state: "not_bound" }} />
    </div>
  );
}

function matchesPolicy(item: RoutingPolicy, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    item.id,
    item.capabilityId,
    item.workItemTypeKey,
    item.workflowTypeKey,
    item.workflowId,
    item.routingMode,
    item.workflow?.name,
    item.workflowTemplateStatus?.state,
    item.workflowTemplateStatus?.reason,
    item.workflowTemplateStatus?.message,
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
}

function hasTemplateIssue(policy: RoutingPolicy): boolean {
  return policy.workflowTemplateStatus?.state === "invalid";
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} style={{ border: 0, background: active ? "#fff" : "transparent", color: active ? "var(--color-primary)" : "var(--color-outline)", borderRadius: 8, padding: "7px 10px", fontWeight: 800, fontSize: 12, cursor: "pointer", boxShadow: active ? "0 1px 2px rgba(15,23,42,0.08)" : "none" }}>{children}</button>;
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return <div className="card" style={{ padding: 14, boxShadow: "none" }}><div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div><div style={{ marginTop: 5, fontWeight: 850, color: tone ?? "var(--color-text)", fontSize: 18 }}>{valueText(value)}</div></div>;
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return <div><div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, overflowWrap: "anywhere" }}>{valueText(value)}</div></div>;
}

function Badge({ children, tone = "#64748b" }: { children: ReactNode; tone?: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${tone}33`, color: tone, background: `${tone}12`, borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>{children}</span>;
}

function inputStyle(extra?: CSSProperties): CSSProperties {
  return { width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", ...extra };
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <details style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, overflow: "hidden" }}>
      <summary style={{ padding: "9px 12px", cursor: "pointer", fontWeight: 800, fontSize: 13, background: "var(--color-surface-container)" }}><FileJson size={14} style={{ display: "inline", marginRight: 6 }} />{title}</summary>
      <pre style={{ margin: 0, padding: 12, maxHeight: 260, overflow: "auto", fontSize: 12, lineHeight: 1.5 }}>{JSON.stringify(value ?? {}, null, 2)}</pre>
    </details>
  );
}

function ErrorPanel({ error }: { error: unknown }) {
  return <section className="card" style={{ padding: 14, marginBottom: 12, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)", color: "#7f1d1d", fontSize: 13 }}>{error instanceof Error ? error.message : String(error)}</section>;
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="card" style={{ padding: 24, color: "var(--color-outline)", textAlign: "center" }}>{text}</div>;
}
