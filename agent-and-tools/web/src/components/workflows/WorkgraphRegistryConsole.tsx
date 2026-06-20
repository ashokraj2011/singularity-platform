"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Archive, ArchiveRestore, CheckCircle2, FileJson, RefreshCw, Search } from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";

type RegistryMode = "connectors" | "metadata";
type Connector = { id: string; name?: string; type?: string; description?: string; config?: Record<string, unknown>; archivedAt?: string | null; createdAt?: string; updatedAt?: string };
type MetadataDefinition = { id: string; kind?: string; key?: string; label?: string; description?: string; category?: string; version?: number; status?: string; scopeType?: string; scopeId?: string; schema?: unknown; defaults?: unknown; policy?: unknown; ui?: unknown; compatibility?: unknown };

export function WorkgraphRegistryConsole({ mode }: { mode: RegistryMode }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("ALL");
  return mode === "connectors"
    ? <ConnectorsView query={query} setQuery={setQuery} />
    : <MetadataView query={query} setQuery={setQuery} kind={kind} setKind={setKind} />;
}

function ConnectorsView({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const path = showArchived ? "/connectors/archived" : "/connectors";
  const { data, error, isLoading, mutate } = useSWR(path, workgraphFetch, { refreshInterval: 12000 });
  const connectors = unwrapWorkgraphItems<Connector>(data, ["connectors"]).filter((item) => matchesConnector(item, query));
  const selected = useMemo(() => connectors.find((item) => item.id === selectedId) ?? connectors[0], [connectors, selectedId]);
  const { data: operations } = useSWR(selected?.id ? `/connectors/${selected.id}/operations` : null, workgraphFetch);

  async function action(label: string, fn: () => Promise<unknown>) {
    try {
      const result = await fn();
      setActionResult(`${label}: ${valueText(result)}`);
      await mutate();
    } catch (err) {
      setActionResult(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <RegistryShell
      eyebrow="Workflow Registry"
      title="Connectors"
      description="Inspect configured Workgraph connectors, available adapter operations, connection test results, and archive state."
      query={query}
      setQuery={setQuery}
      actions={<><button className="btn-secondary" type="button" onClick={() => setShowArchived((value) => !value)}>{showArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{showArchived ? "Active" : "Archived"}</button><button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={14} /> Refresh</button></>}
    >
      {error && <ErrorPanel error={error} />}
      {actionResult && <section className="card" style={{ padding: 12, marginBottom: 12, color: "var(--color-outline)", fontSize: 13 }}>{actionResult}</section>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 0.9fr) minmax(360px, 1.1fr)", gap: 16, alignItems: "start" }}>
        <section style={{ display: "grid", gap: 10 }}>
          {isLoading && <EmptyPanel text="Loading connectors..." />}
          {!isLoading && connectors.length === 0 && <EmptyPanel text="No connectors match this view." />}
          {connectors.map((connector) => (
            <button key={connector.id} type="button" onClick={() => setSelectedId(connector.id)} className="card card-hover" style={{ padding: 14, textAlign: "left", border: selected?.id === connector.id ? "1px solid rgba(54,135,39,0.42)" : undefined, background: selected?.id === connector.id ? "rgba(240,253,244,0.74)" : undefined, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <strong>{connector.name ?? shortId(connector.id)}</strong>
                <Badge>{connector.type ?? "connector"}</Badge>
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 12 }}>{connector.description ?? "No description"} · {formatDate(connector.updatedAt ?? connector.createdAt)}</div>
            </button>
          ))}
        </section>
        <section className="card" style={{ padding: 18, minWidth: 0 }}>
          {selected ? (
            <div style={{ display: "grid", gap: 16 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20 }}>{selected.name ?? "Connector"}</h2>
                <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>{selected.description ?? "No description"}</p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-secondary text-xs" type="button" onClick={() => action("Test", () => workgraphFetch(`/connectors/${selected.id}/test`, { method: "POST", body: "{}" }))}><CheckCircle2 size={13} /> Test</button>
                {selected.archivedAt ? (
                  <button className="btn-secondary text-xs" type="button" onClick={() => action("Restore", () => workgraphFetch(`/connectors/${selected.id}/restore`, { method: "POST", body: "{}" }))}><ArchiveRestore size={13} /> Restore</button>
                ) : (
                  <button className="btn-secondary text-xs" type="button" onClick={() => action("Archive", () => workgraphFetch(`/connectors/${selected.id}/archive`, { method: "POST", body: "{}" }))}><Archive size={13} /> Archive</button>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                <Fact label="Type" value={selected.type} />
                <Fact label="Created" value={formatDate(selected.createdAt)} />
                <Fact label="Updated" value={formatDate(selected.updatedAt)} />
                <Fact label="ID" value={selected.id} />
              </div>
              <JsonPanel title="Config" value={selected.config} />
              <JsonPanel title="Operations" value={operations} />
            </div>
          ) : <EmptyPanel text="Select a connector." />}
        </section>
      </div>
    </RegistryShell>
  );
}

function MetadataView({ query, setQuery, kind, setKind }: { query: string; setQuery: (value: string) => void; kind: string; setKind: (value: string) => void }) {
  const path = `/metadata-definitions${kind === "ALL" ? "" : `?kind=${encodeURIComponent(kind)}`}`;
  const { data, error, isLoading, mutate } = useSWR(path, workgraphFetch, { refreshInterval: 12000 });
  const items = unwrapWorkgraphItems<MetadataDefinition>(data).filter((item) => matchesMetadata(item, query));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0], [items, selectedId]);
  const kinds = ["ALL", "WORK_ITEM_TYPE", "WORKFLOW_TYPE", "NODE_TYPE", "EVENT_TYPE", "TRIGGER_PROFILE"];

  return (
    <RegistryShell
      eyebrow="Workflow Registry"
      title="Metadata Definitions"
      description="Review the metadata catalog that drives work item types, workflow types, node types, trigger profiles, schemas, defaults, and UI policy."
      query={query}
      setQuery={setQuery}
      actions={<><select value={kind} onChange={(event) => setKind(event.target.value)} style={selectStyle}>{kinds.map((item) => <option key={item} value={item}>{item}</option>)}</select><button className="btn-secondary" type="button" onClick={() => void mutate()}><RefreshCw size={14} /> Refresh</button></>}
    >
      {error && <ErrorPanel error={error} />}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
        {kinds.slice(1).map((item) => <Metric key={item} label={item.replaceAll("_", " ")} value={items.filter((def) => def.kind === item).length} />)}
      </section>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 0.95fr) minmax(360px, 1.05fr)", gap: 16, alignItems: "start" }}>
        <section style={{ display: "grid", gap: 10 }}>
          {isLoading && <EmptyPanel text="Loading metadata definitions..." />}
          {!isLoading && items.length === 0 && <EmptyPanel text="No metadata definitions match this view." />}
          {items.map((item) => (
            <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className="card card-hover" style={{ padding: 14, textAlign: "left", border: selected?.id === item.id ? "1px solid rgba(54,135,39,0.42)" : undefined, background: selected?.id === item.id ? "rgba(240,253,244,0.74)" : undefined, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <strong>{item.label ?? item.key ?? shortId(item.id)}</strong>
                <Badge>{item.status ?? "UNKNOWN"}</Badge>
              </div>
              <div style={{ color: "var(--color-outline)", fontSize: 12 }}>{item.kind} · {item.key} · v{item.version ?? 1} · {item.scopeType ?? "GLOBAL"}</div>
            </button>
          ))}
        </section>
        <section className="card" style={{ padding: 18, minWidth: 0 }}>
          {selected ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20 }}>{selected.label ?? selected.key}</h2>
                <p style={{ margin: "6px 0 0", color: "var(--color-outline)", fontSize: 13 }}>{selected.description ?? "No description"}</p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                <Fact label="Kind" value={selected.kind} />
                <Fact label="Key" value={selected.key} />
                <Fact label="Scope" value={`${selected.scopeType ?? "-"} / ${selected.scopeId ?? "-"}`} />
                <Fact label="Category" value={selected.category} />
              </div>
              <JsonPanel title="Schema" value={selected.schema} />
              <JsonPanel title="Defaults" value={selected.defaults} />
              <JsonPanel title="Policy" value={selected.policy} />
              <JsonPanel title="UI" value={selected.ui} />
            </div>
          ) : <EmptyPanel text="Select a metadata definition." />}
        </section>
      </div>
    </RegistryShell>
  );
}

function RegistryShell({ eyebrow, title, description, query, setQuery, actions, children }: { eyebrow: string; title: string; description: string; query: string; setQuery: (value: string) => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ maxWidth: 1360 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>{eyebrow}</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>{title}</h1>
            <p style={{ margin: 0, maxWidth: 780, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>{description}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
        </div>
      </section>
      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ position: "relative", maxWidth: 420 }}>
          <Search size={14} style={{ position: "absolute", left: 11, top: 11, color: "var(--color-outline)" }} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search registry" style={{ width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px 9px 33px", fontSize: 13 }} />
        </div>
      </section>
      {children}
    </div>
  );
}

function matchesConnector(item: Connector, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.name, item.type, item.description, item.id].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
}

function matchesMetadata(item: MetadataDefinition, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.kind, item.key, item.label, item.description, item.category, item.status, item.scopeType, item.scopeId].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return <div className="card" style={{ padding: 14, boxShadow: "none" }}><div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div><div style={{ marginTop: 5, fontWeight: 850, fontSize: 18 }}>{valueText(value)}</div></div>;
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return <div><div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, overflowWrap: "anywhere" }}>{valueText(value)}</div></div>;
}

function Badge({ children }: { children: ReactNode }) {
  return <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid rgba(100,116,139,0.24)", color: "#475569", background: "rgba(248,250,252,0.9)", borderRadius: 999, padding: "3px 8px", fontSize: 11, fontWeight: 850, textTransform: "uppercase" }}>{children}</span>;
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <details open={title === "Operations"} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, overflow: "hidden" }}>
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

const selectStyle: CSSProperties = { border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "8px 10px", fontSize: 13, background: "#fff" };
