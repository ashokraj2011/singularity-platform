"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Archive, CheckCircle2, GitBranch, Play, Plus, RefreshCw, Route, Search, UserCheck, X } from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";

type WorkItemTarget = {
  id: string;
  targetCapabilityId?: string | null;
  status?: string | null;
  claimedById?: string | null;
  childWorkflowTemplateId?: string | null;
  childWorkflowInstanceId?: string | null;
  roleKey?: string | null;
};

type WorkItem = {
  id: string;
  workCode?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  workItemTypeKey?: string | null;
  workflowTypeKey?: string | null;
  routingMode?: string | null;
  routingState?: string | null;
  urgency?: string | null;
  priority?: number | null;
  dueAt?: string | null;
  targetCapabilityId?: string | null;
  sourceWorkflowInstanceId?: string | null;
  sourceWorkflowNodeId?: string | null;
  targets?: WorkItemTarget[];
  events?: Array<{ id?: string; eventType?: string; type?: string; message?: string; createdAt?: string; payload?: unknown }>;
  clarifications?: Array<{ id?: string; question?: string; answer?: string; createdAt?: string }>;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const filterOptions = [
  { label: "Open", query: "" },
  { label: "Available", query: "available=true" },
  { label: "Mine", query: "mine=true" },
  { label: "Archived", query: "archived=true" },
];

function statusTone(status?: string | null) {
  const normalized = String(status ?? "").toUpperCase();
  if (["COMPLETED", "APPROVED"].includes(normalized)) return "#15803d";
  if (["IN_PROGRESS", "CLAIMED", "SUBMITTED"].includes(normalized)) return "#2563eb";
  if (["AWAITING_PARENT_APPROVAL", "REWORK_REQUESTED", "SCHEDULED"].includes(normalized)) return "#b45309";
  if (["CANCELLED", "ARCHIVED"].includes(normalized)) return "#64748b";
  return "#64748b";
}

export function WorkItemsConsole() {
  const [filter, setFilter] = useState(filterOptions[0].query);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const path = `/work-items?limit=100${filter ? `&${filter}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR(path, workgraphFetch, { refreshInterval: 10000 });
  const items = unwrapWorkgraphItems<WorkItem>(data, ["workItems"]).filter((item) => matches(item, query));
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0], [items, selectedId]);

  async function runAction(label: string, fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      await mutate();
    } catch (err) {
      setActionError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div style={{ maxWidth: 1360 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workgraph</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>WorkItems</h1>
            <p style={{ margin: 0, maxWidth: 760, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              Route capability-scoped work, claim targets, attach or start workflows, approve submitted children, and inspect recent WorkItem events.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn-primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={15} /> New WorkItem</button>
            <button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={15} /> Refresh</button>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="Shown" value={items.length} />
        <Metric label="In progress" value={items.filter((item) => item.status === "IN_PROGRESS").length} tone="#2563eb" />
        <Metric label="Awaiting approval" value={items.filter((item) => item.status === "AWAITING_PARENT_APPROVAL").length} tone="#b45309" />
        <Metric label="Targets" value={items.reduce((count, item) => count + (item.targets?.length ?? 0), 0)} />
      </section>

      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6, background: "var(--color-surface-container)", padding: 4, borderRadius: 10 }}>
            {filterOptions.map((option) => <Segment key={option.label} active={filter === option.query} onClick={() => setFilter(option.query)}>{option.label}</Segment>)}
          </div>
          <div style={{ position: "relative", minWidth: 240, flex: "0 1 380px" }}>
            <Search size={14} style={{ position: "absolute", left: 11, top: 11, color: "var(--color-outline)" }} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search WorkItems" style={inputStyle({ paddingLeft: 33 })} />
          </div>
        </div>
      </section>

      {error && <ErrorPanel error={error} />}
      {actionError && <ErrorPanel error={new Error(actionError)} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 0.95fr) minmax(360px, 1.05fr)", gap: 16, alignItems: "start" }}>
        <section style={{ display: "grid", gap: 10 }}>
          {isLoading && <EmptyPanel text="Loading WorkItems..." />}
          {!isLoading && items.length === 0 && <EmptyPanel text="No WorkItems match this view." />}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedId(item.id)}
              className="card card-hover"
              style={{
                padding: 15,
                textAlign: "left",
                border: selected?.id === item.id ? "1px solid rgba(0,132,61,0.42)" : undefined,
                background: selected?.id === item.id ? "rgba(240,253,244,0.74)" : undefined,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <strong style={{ fontSize: 14, overflowWrap: "anywhere" }}>{item.title ?? item.workCode ?? item.id}</strong>
                    <Badge tone={statusTone(item.status)}>{item.status ?? "UNKNOWN"}</Badge>
                  </div>
                  <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>
                    {item.workCode ?? shortId(item.id)} · {item.workItemTypeKey ?? "GENERAL"} · {item.routingMode ?? "MANUAL"}
                  </p>
                </div>
                <span className="badge">{item.targets?.length ?? 0} targets</span>
              </div>
            </button>
          ))}
        </section>

        <section className="card" style={{ padding: 18, minWidth: 0 }}>
          {selected ? (
            <WorkItemDetail item={selected} onAction={runAction} />
          ) : (
            <EmptyPanel text="Select a WorkItem to inspect targets and actions." />
          )}
        </section>
      </div>

      {createOpen && <CreateWorkItemDialog onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void mutate(); }} />}
    </div>
  );
}

function WorkItemDetail({ item, onAction }: { item: WorkItem; onAction: (label: string, fn: () => Promise<unknown>) => void }) {
  const firstTarget = item.targets?.[0];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>{item.title ?? item.workCode ?? "WorkItem"}</h2>
            <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>{item.description ?? "No description"}</p>
          </div>
          <Badge tone={statusTone(item.status)}>{item.status ?? "UNKNOWN"}</Badge>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <Fact label="Work code" value={item.workCode} />
          <Fact label="Type" value={item.workItemTypeKey} />
          <Fact label="Routing" value={`${item.routingMode ?? "-"} / ${item.routingState ?? "-"}`} />
          <Fact label="Urgency" value={item.urgency} />
          <Fact label="Due" value={formatDate(item.dueAt)} />
          <Fact label="Updated" value={formatDate(item.updatedAt ?? item.createdAt)} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn-secondary text-xs" type="button" onClick={() => onAction("Route", () => workgraphFetch(`/work-items/${item.id}/route`, { method: "POST", body: "{}" }))}><Route size={13} /> Route</button>
        <button className="btn-secondary text-xs" type="button" onClick={() => onAction("Start", () => workgraphFetch(`/work-items/${item.id}/start`, { method: "POST", body: "{}" }))}><Play size={13} /> Start</button>
        <button className="btn-secondary text-xs" type="button" disabled={!firstTarget} onClick={() => firstTarget && onAction("Claim target", () => workgraphFetch(`/work-items/${item.id}/targets/${firstTarget.id}/claim`, { method: "POST", body: "{}" }))}><UserCheck size={13} /> Claim first target</button>
        <button className="btn-secondary text-xs" type="button" onClick={() => onAction("Approve", () => workgraphFetch(`/work-items/${item.id}/approve`, { method: "POST", body: "{}" }))}><CheckCircle2 size={13} /> Approve</button>
        <button className="btn-secondary text-xs" type="button" onClick={() => onAction("Archive", () => workgraphFetch(`/work-items/${item.id}/archive`, { method: "POST", body: "{}" }))}><Archive size={13} /> Archive</button>
        {item.sourceWorkflowInstanceId && <Link className="btn-secondary text-xs" href={`/runs/${item.sourceWorkflowInstanceId}`}><GitBranch size={13} /> Source run</Link>}
      </div>

      <section>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Targets</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {(item.targets ?? []).map((target) => (
            <article key={target.id} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>{shortId(target.targetCapabilityId)}</strong>
                <Badge tone={statusTone(target.status)}>{target.status ?? "UNKNOWN"}</Badge>
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 12, lineHeight: 1.55 }}>
                Role {target.roleKey ?? "-"} · Claimed {shortId(target.claimedById)} · Workflow {shortId(target.childWorkflowInstanceId ?? target.childWorkflowTemplateId)}
              </div>
            </article>
          ))}
          {(item.targets ?? []).length === 0 && <EmptyPanel text="No targets attached." />}
        </div>
      </section>

      <section>
        <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Recent Events</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {(item.events ?? []).slice(0, 8).map((event, index) => (
            <article key={event.id ?? index} style={{ borderBottom: "1px solid var(--color-outline-variant)", paddingBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--color-outline)", fontSize: 12 }}>
                <span>{event.eventType ?? event.type ?? "event"}</span>
                <span>{formatDate(event.createdAt)}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 13 }}>{event.message ?? valueText(event.payload)}</div>
            </article>
          ))}
          {(item.events ?? []).length === 0 && <EmptyPanel text="No recent events." />}
        </div>
      </section>
    </div>
  );
}

function CreateWorkItemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetCapabilityId, setTargetCapabilityId] = useState("");
  const [workItemTypeKey, setWorkItemTypeKey] = useState("GENERAL");
  const [routingMode, setRoutingMode] = useState("MANUAL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await workgraphFetch("/work-items", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          workItemTypeKey,
          routingMode,
          targets: [{ targetCapabilityId: targetCapabilityId.trim() }],
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdrop}>
      <section className="card" style={modalCard}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)" }}>Create WorkItem</div>
            <h2 style={{ margin: "4px 0 0", fontSize: 20 }}>New capability work</h2>
          </div>
          <button className="btn-secondary" type="button" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <Field label="Title"><input value={title} onChange={(event) => setTitle(event.target.value)} style={inputStyle()} autoFocus /></Field>
          <Field label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} style={inputStyle({ resize: "vertical" })} /></Field>
          <Field label="Target capability id"><input value={targetCapabilityId} onChange={(event) => setTargetCapabilityId(event.target.value)} style={inputStyle()} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <Field label="Work item type"><input value={workItemTypeKey} onChange={(event) => setWorkItemTypeKey(event.target.value)} style={inputStyle()} /></Field>
            <Field label="Routing mode">
              <select value={routingMode} onChange={(event) => setRoutingMode(event.target.value)} style={inputStyle()}>
                <option value="MANUAL">Manual</option>
                <option value="AUTO_ATTACH">Auto attach</option>
                <option value="AUTO_START">Auto start</option>
                <option value="SCHEDULED_START">Scheduled start</option>
              </select>
            </Field>
          </div>
          {error && <ErrorPanel error={new Error(error)} />}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="btn-primary" type="button" disabled={busy || !title.trim() || !targetCapabilityId.trim()} onClick={() => void create()}>{busy ? "Creating..." : "Create"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function matches(item: WorkItem, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.title, item.description, item.workCode, item.status, item.workItemTypeKey, item.routingMode, item.routingState, ...(item.targets ?? []).map((target) => target.targetCapabilityId)]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--color-outline)", fontWeight: 800 }}>{label}{children}</label>;
}

function inputStyle(extra?: CSSProperties): CSSProperties {
  return { width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", ...extra };
}

function ErrorPanel({ error }: { error: unknown }) {
  return <section className="card" style={{ padding: 14, marginBottom: 12, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)", color: "#7f1d1d", fontSize: 13 }}>{error instanceof Error ? error.message : String(error)}</section>;
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="card" style={{ padding: 24, color: "var(--color-outline)", textAlign: "center" }}>{text}</div>;
}

const modalBackdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 60, background: "rgba(15,23,42,0.34)", display: "grid", placeItems: "center", padding: 18 };
const modalCard: CSSProperties = { width: "min(720px, 100%)", maxHeight: "90vh", overflow: "auto", padding: 20 };
