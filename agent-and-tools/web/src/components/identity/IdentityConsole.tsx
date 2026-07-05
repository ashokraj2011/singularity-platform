"use client";

import { useState } from "react";
import useSWR from "swr";
import { CircleAlert, GitBranch, ShieldCheck, ShieldX, Users } from "lucide-react";
import {
  checkAuthorization,
  createIdentity,
  createMcpServer,
  listCapabilityRelationships,
  listIdentity,
  listMcpServers,
  type AuthzCheckRequest,
  type AuthzCheckResponse,
  type CapabilityRelationshipRow,
  type IdentityRow,
  type IdentityView,
} from "@/lib/identity/api";
import { formatDate, valueText } from "@/lib/workgraph";

const viewCopy: Record<IdentityView, { title: string; description: string }> = {
  dashboard: {
    title: "Identity Dashboard",
    description: "Monitor IAM users, teams, capabilities, and recent audit activity from the unified platform shell.",
  },
  users: {
    title: "Users",
    description: "Inspect IAM users, status, identity provider metadata, and user IDs used by authorization checks.",
  },
  teams: {
    title: "Teams",
    description: "Review team hierarchy, business-unit membership, and team identifiers used by capability grants.",
  },
  "business-units": {
    title: "Business Units",
    description: "Inspect organizational units and parent-child ownership for teams and capabilities.",
  },
  capabilities: {
    title: "Capabilities",
    description: "Review registered capabilities, capability IDs, types, status, and IAM authorization anchors.",
  },
  "capability-graph": {
    title: "Capability Graph",
    description: "Visualize capability relationships, sharing paths, inheritance policies, and graph coverage.",
  },
  roles: {
    title: "Roles",
    description: "Inspect named IAM roles and the permission groups attached to platform actors.",
  },
  permissions: {
    title: "Permissions",
    description: "Browse available permission keys, scopes, resource types, and descriptions.",
  },
  "sharing-grants": {
    title: "Sharing Grants",
    description: "Inspect provider-to-consumer capability sharing grants, grant status, and access direction.",
  },
  audit: {
    title: "IAM Audit",
    description: "Review IAM audit events, actors, target resources, and authorization-relevant changes.",
  },
  "authz-check": {
    title: "Authorization Check",
    description: "Evaluate whether a user can perform an action on a capability/resource with the current policy graph.",
  },
  "mcp-servers": {
    title: "MCP Servers",
    description: "Register and review the MCP tool servers available to each capability.",
  },
};

const columns: Record<IdentityView, Array<{ label: string; keys: string[] }>> = {
  dashboard: [],
  users: [
    { label: "Email", keys: ["email"] },
    { label: "Name", keys: ["display_name", "name"] },
    { label: "Status", keys: ["status"] },
    { label: "ID", keys: ["id"] },
  ],
  teams: [
    { label: "Team", keys: ["name"] },
    { label: "Key", keys: ["team_key", "key"] },
    { label: "Business Unit", keys: ["bu_id", "business_unit_id"] },
    { label: "ID", keys: ["id"] },
  ],
  "business-units": [
    { label: "Business Unit", keys: ["name"] },
    { label: "Key", keys: ["bu_key", "key"] },
    { label: "Parent", keys: ["parent_id", "parentId"] },
    { label: "ID", keys: ["id"] },
  ],
  capabilities: [
    { label: "Capability", keys: ["name", "display_name"] },
    { label: "Key", keys: ["capability_key", "key", "capability_id"] },
    { label: "Type", keys: ["capability_type", "type"] },
    { label: "Status", keys: ["status"] },
  ],
  "capability-graph": [
    { label: "Capability", keys: ["name", "display_name"] },
    { label: "Key", keys: ["capability_key", "key", "capability_id"] },
    { label: "Parent", keys: ["parent_id", "parentId"] },
    { label: "Status", keys: ["status"] },
  ],
  roles: [
    { label: "Role", keys: ["name", "role_key"] },
    { label: "Key", keys: ["role_key", "key"] },
    { label: "Description", keys: ["description"] },
    { label: "ID", keys: ["id"] },
  ],
  permissions: [
    { label: "Permission", keys: ["name", "permission_key"] },
    { label: "Key", keys: ["permission_key", "key"] },
    { label: "Scope", keys: ["scope", "resource_type"] },
    { label: "Description", keys: ["description"] },
  ],
  "sharing-grants": [
    { label: "Capability", keys: ["capability_id", "capabilityId"] },
    { label: "Grantee", keys: ["grantee_id", "granteeId"] },
    { label: "Type", keys: ["grantee_type", "granteeType"] },
    { label: "Status", keys: ["status"] },
  ],
  audit: [
    { label: "Event", keys: ["event_type", "type"] },
    { label: "Action", keys: ["action"] },
    { label: "Actor", keys: ["actor_id", "actorId"] },
    { label: "Created", keys: ["created_at", "createdAt"] },
  ],
  "authz-check": [],
  "mcp-servers": [],
};

// ── Create forms ─────────────────────────────────────────────────────────────
// Field specs per creatable IAM entity. Keys map 1:1 to the IAM create-request
// bodies (bu_key, name, …); `tags` is parsed comma→array on submit.
type FieldSpec = { key: string; label: string; required?: boolean; placeholder?: string; textarea?: boolean; hint?: string };

const createForms: Partial<Record<IdentityView, { singular: string; fields: FieldSpec[] }>> = {
  "business-units": {
    singular: "Business Unit",
    fields: [
      { key: "bu_key", label: "Key", required: true, placeholder: "engineering", hint: "Unique identifier; can't be changed later." },
      { key: "name", label: "Name", required: true, placeholder: "Engineering" },
      { key: "description", label: "Description", textarea: true },
      { key: "parent_bu_id", label: "Parent BU ID", placeholder: "(optional UUID)" },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  teams: {
    singular: "Team",
    fields: [
      { key: "team_key", label: "Key", required: true, placeholder: "platform-eng" },
      { key: "name", label: "Name", required: true, placeholder: "Platform Engineering" },
      { key: "bu_key", label: "Business Unit key", placeholder: "engineering", hint: "Must match an existing Business Unit key — otherwise the team is created with no BU." },
      { key: "description", label: "Description", textarea: true },
      { key: "parent_team_id", label: "Parent team ID", placeholder: "(optional UUID)" },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  users: {
    singular: "User",
    fields: [
      { key: "email", label: "Email", required: true, placeholder: "person@example.com" },
      { key: "display_name", label: "Display name", placeholder: "Jane Doe" },
      { key: "auth_provider", label: "Auth provider", placeholder: "(optional)" },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  roles: {
    singular: "Role",
    fields: [
      { key: "role_key", label: "Key", required: true, placeholder: "reviewer" },
      { key: "name", label: "Name", required: true, placeholder: "Reviewer" },
      { key: "description", label: "Description", textarea: true },
      { key: "role_scope", label: "Scope", placeholder: "capability" },
    ],
  },
  capabilities: {
    singular: "Capability",
    fields: [
      { key: "capability_id", label: "Capability ID", required: true, placeholder: "payments" },
      { key: "name", label: "Name", required: true, placeholder: "Payments" },
      { key: "capability_type", label: "Type", required: true, placeholder: "service" },
      { key: "description", label: "Description", textarea: true },
      { key: "visibility", label: "Visibility", placeholder: "private" },
      { key: "owner_bu_key", label: "Owner BU key", placeholder: "(optional)" },
      { key: "owner_team_key", label: "Owner team key", placeholder: "(optional)" },
    ],
  },
};

function buildCreateBody(fields: FieldSpec[], values: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (!raw) continue;
    body[f.key] = f.key === "tags" ? raw.split(",").map((t) => t.trim()).filter(Boolean) : raw;
  }
  return body;
}

export function IdentityConsole({ view = "dashboard" }: { view?: IdentityView }) {
  // The sub-view comes straight from the route — the global sidebar is the only
  // Identity nav now (no in-page column), so there's no local active-view state.
  const activeView = view;
  const copy = viewCopy[activeView];

  const { data: users, error: usersError } = useSWR("identity-users-count", () => listIdentity("users", 25));
  const { data: teams } = useSWR("identity-teams-count", () => listIdentity("teams", 25));
  const { data: capabilities } = useSWR("identity-capabilities-count", () => listIdentity("capabilities", 25));
  const { data: audit } = useSWR("identity-audit-count", () => listIdentity("audit", 10));
  const listView = activeView === "dashboard" || activeView === "mcp-servers" ? null : activeView;
  const { data: rows, error: rowsError, isLoading, mutate: mutateRows } = useSWR(listView ? ["identity-list", listView] : null, () => listIdentity(listView as IdentityView, 100));
  const error = usersError ?? rowsError;

  return (
    <div style={{ maxWidth: 1440 }}>
      <section className="card" style={{ padding: 22, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textTransform: "uppercase", marginBottom: 10 }}>
              <ShieldCheck size={15} />
              Identity
            </div>
            <h1 className="page-header" style={{ margin: 0 }}>{copy.title}</h1>
            <p style={{ margin: "10px 0 0", maxWidth: 820, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              {copy.description}
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(90px, 1fr))", gap: 8, minWidth: 360 }}>
            <Metric label="Users" value={users?.total ?? "-"} />
            <Metric label="Teams" value={teams?.total ?? "-"} tone="#0284c7" />
            <Metric label="Capabilities" value={capabilities?.total ?? "-"} tone="#7c3aed" />
            <Metric label="Audit" value={audit?.total ?? "-"} tone="#b45309" />
          </div>
        </div>
      </section>

      {error ? <ErrorBanner error={error} /> : null}

      <main style={{ display: "grid", gap: 16, minWidth: 0 }}>
        {activeView === "dashboard" ? (
          <DashboardPanel users={users?.items ?? []} audit={audit?.items ?? []} />
        ) : activeView === "capability-graph" ? (
          <CapabilityGraphPanel capabilities={rows?.items ?? []} loading={isLoading} />
        ) : activeView === "authz-check" ? (
          <AuthzPanel permissions={rows?.items ?? []} />
        ) : activeView === "mcp-servers" ? (
          <McpServersPanel />
        ) : (
          <EntityTable title={titleFor(activeView)} view={activeView} rows={rows?.items ?? []} loading={isLoading} onCreated={() => void mutateRows()} />
        )}
      </main>
    </div>
  );
}

function DashboardPanel({ users, audit }: { users: IdentityRow[]; audit: IdentityRow[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.85fr)", gap: 16 }}>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Recent Users</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {users.slice(0, 8).map((user, index) => (
            <article key={String(user.id ?? user.email ?? index)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12 }}>
              <strong style={{ fontSize: 13 }}>{valueText(user.display_name ?? user.name ?? user.email)}</strong>
              <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 4 }}>{valueText(user.email)} · {valueText(user.status)}</div>
            </article>
          ))}
          {users.length === 0 && <EmptyPanel label="No users returned by IAM." />}
        </div>
      </section>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Recent Audit Events</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {audit.slice(0, 10).map((event, index) => (
            <article key={String(event.id ?? index)} style={{ borderBottom: "1px solid var(--color-outline-variant)", paddingBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "var(--color-outline)", fontSize: 12 }}>
                <span>{valueText(event.event_type ?? event.type)}</span>
                <span>{formatDate(event.created_at ?? event.createdAt)}</span>
              </div>
              <div style={{ marginTop: 3, fontSize: 13 }}>{valueText(event.action ?? event.capability_id ?? event.resource_type)}</div>
            </article>
          ))}
          {audit.length === 0 && <EmptyPanel label="No audit events returned by IAM." />}
        </div>
      </section>
    </div>
  );
}

function EntityTable({ title, view, rows, loading, onCreated }: { title: string; view: IdentityView; rows: IdentityRow[]; loading?: boolean; onCreated?: () => void }) {
  const tableColumns = columns[view];
  const [creating, setCreating] = useState(false);
  const form = createForms[view];
  return (
    <section className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: 18, borderBottom: "1px solid var(--color-outline-variant)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{loading ? "Loading" : `${rows.length} shown`}</span>
          {form && onCreated ? (
            <button type="button" className="btn-primary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setCreating(true)}>
              ＋ New {form.singular}
            </button>
          ) : null}
        </div>
      </div>
      {creating && form && onCreated ? (
        <CreateEntityModal view={view} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); onCreated(); }} />
      ) : null}
      <div style={{ overflowX: "auto" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {tableColumns.map((column) => <th key={column.label} className="text-left px-4 py-3 font-medium text-slate-600">{column.label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={String(row.id ?? index)} className="hover:bg-slate-50">
                {tableColumns.map((column) => <td key={column.label} className="px-4 py-3 text-slate-700">{formatCell(pick(row, column.keys))}</td>)}
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={tableColumns.length} className="px-4 py-12 text-center text-slate-400">No records found.</td></tr>}
            {loading && <tr><td colSpan={tableColumns.length} className="px-4 py-12 text-center text-slate-400">Loading...</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CreateEntityModal({ view, onClose, onCreated }: { view: IdentityView; onClose: () => void; onCreated: () => void }) {
  const spec = createForms[view]!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missingRequired = spec.fields.some((f) => f.required && !(values[f.key] ?? "").trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await createIdentity(view, buildCreateBody(spec.fields, values));
      onCreated(); // unmounts this modal + refreshes the list
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>New {spec.singular}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-outline)" }}>Requires super-admin. Fields marked * are required.</p>
        <div style={{ display: "grid", gap: 10 }}>
          {spec.fields.map((f) => (
            <label key={f.key} style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
              {f.label}{f.required ? " *" : ""}
              {f.textarea ? (
                <textarea value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} placeholder={f.placeholder} rows={3} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500, resize: "vertical" }} />
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} placeholder={f.placeholder} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }} />
              )}
              {f.hint ? <span style={{ fontWeight: 500, color: "var(--color-outline)", fontSize: 11 }}>{f.hint}</span> : null}
            </label>
          ))}
        </div>
        {error ? <div style={{ marginTop: 12 }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || missingRequired}>{busy ? "Creating…" : `Create ${spec.singular}`}</button>
        </div>
      </div>
    </div>
  );
}

function McpServersPanel() {
  const { data: caps } = useSWR("identity-caps-for-mcp", () => listIdentity("capabilities", 200));
  const capabilities = caps?.items ?? [];
  const [capId, setCapId] = useState("");
  const effectiveCapId = capId || String(capabilities[0]?.id ?? "");
  const { data: servers, isLoading, mutate } = useSWR(effectiveCapId ? ["mcp-servers", effectiveCapId] : null, () => listMcpServers(effectiveCapId));
  const serverRows: IdentityRow[] = Array.isArray(servers) ? servers : (servers?.items ?? []);
  const [creating, setCreating] = useState(false);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", justifyContent: "space-between" }}>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)", flex: 1, minWidth: 280 }}>
            Capability
            <select value={effectiveCapId} onChange={(e) => setCapId(e.target.value)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
              {capabilities.length === 0 ? <option value="">No capabilities available</option> : null}
              {capabilities.map((c) => {
                const id = String(c.id ?? "");
                return <option key={id} value={id}>{valueText(c.name ?? c.display_name ?? c.capability_id ?? id)}</option>;
              })}
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={!effectiveCapId} onClick={() => setCreating(true)}>＋ New MCP server</button>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--color-outline)" }}>MCP servers are registered per capability. Requires super-admin.</p>
      </section>

      <section className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: 18, borderBottom: "1px solid var(--color-outline-variant)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Registered MCP servers</h2>
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{isLoading ? "Loading" : `${serverRows.length} shown`}</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {["Name", "Base URL", "Protocol", "Status"].map((h) => <th key={h} className="text-left px-4 py-3 font-medium text-slate-600">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {serverRows.map((s, index) => (
                <tr key={String(s.id ?? index)} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-700">{valueText(s.name)}</td>
                  <td className="px-4 py-3 text-slate-700">{valueText(s.base_url)}</td>
                  <td className="px-4 py-3 text-slate-700">{valueText(s.protocol)}</td>
                  <td className="px-4 py-3 text-slate-700">{valueText(s.status)}</td>
                </tr>
              ))}
              {!isLoading && serverRows.length === 0 && <tr><td colSpan={4} className="px-4 py-12 text-center text-slate-400">No MCP servers registered for this capability.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {creating && effectiveCapId ? (
        <CreateMcpServerModal capabilityId={effectiveCapId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void mutate(); }} />
      ) : null}
    </div>
  );
}

function CreateMcpServerModal({ capabilityId, onClose, onCreated }: { capabilityId: string; onClose: () => void; onCreated: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({ protocol: "MCP_HTTP" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (v: string) => setValues((prev) => ({ ...prev, [k]: v }));
  const name = (values.name ?? "").trim();
  const baseUrl = (values.base_url ?? "").trim();
  const token = (values.bearer_token ?? "").trim();
  const invalid = !name || !baseUrl || token.length < 8;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, base_url: baseUrl, bearer_token: token, protocol: values.protocol || "MCP_HTTP" };
      const desc = (values.description ?? "").trim();
      const ver = (values.protocol_version ?? "").trim();
      const tags = (values.tags ?? "").trim();
      if (desc) body.description = desc;
      if (ver) body.protocol_version = ver;
      if (tags) body.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
      await createMcpServer(capabilityId, body);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>New MCP server</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-outline)" }}>Registered under the selected capability. Requires super-admin. * = required.</p>
        <div style={{ display: "grid", gap: 10 }}>
          <IdentityInput label="Name *" value={values.name ?? ""} onChange={set("name")} placeholder="primary-mcp" />
          <IdentityInput label="Base URL *" value={values.base_url ?? ""} onChange={set("base_url")} placeholder="https://mcp.example.com" />
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
            Bearer token *
            <input type="password" value={values.bearer_token ?? ""} onChange={(e) => set("bearer_token")(e.target.value)} placeholder="min 8 characters" style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }} />
            <span style={{ fontWeight: 500, color: "var(--color-outline)", fontSize: 11 }}>Stored server-side for context-fabric → MCP auth.</span>
          </label>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
            Protocol
            <select value={values.protocol ?? "MCP_HTTP"} onChange={(e) => set("protocol")(e.target.value)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }}>
              <option value="MCP_HTTP">MCP_HTTP</option>
              <option value="MCP_WS">MCP_WS</option>
            </select>
          </label>
          <IdentityInput label="Protocol version" value={values.protocol_version ?? ""} onChange={set("protocol_version")} placeholder="(optional)" />
          <IdentityInput label="Description" value={values.description ?? ""} onChange={set("description")} placeholder="(optional)" />
          <IdentityInput label="Tags" value={values.tags ?? ""} onChange={set("tags")} placeholder="comma, separated" />
        </div>
        {error ? <div style={{ marginTop: 12 }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || invalid}>{busy ? "Registering…" : "Register MCP server"}</button>
        </div>
      </div>
    </div>
  );
}

function CapabilityGraphPanel({ capabilities, loading }: { capabilities: IdentityRow[]; loading?: boolean }) {
  const capabilityIds = capabilities
    .map((capability) => String(capability.capability_id ?? capability.id ?? ""))
    .filter(Boolean)
    .slice(0, 60);
  const { data: relationships = [], error, isLoading } = useSWR(
    capabilityIds.length ? ["identity-capability-relationships", capabilityIds.join("|")] : null,
    async () => {
      const batches = await Promise.all(capabilityIds.map(async (capabilityId) => {
        try {
          return await listCapabilityRelationships(capabilityId);
        } catch {
          return [] as CapabilityRelationshipRow[];
        }
      }));
      const seen = new Set<string>();
      return batches.flat().filter((relationship) => {
        const key = String(relationship.id ?? `${relationship.source_capability_id}:${relationship.target_capability_id}:${relationship.relationship_type}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  );
  const names = new Map(capabilities.map((capability) => [
    String(capability.capability_id ?? capability.id ?? ""),
    String(capability.name ?? capability.display_name ?? capability.capability_id ?? capability.id ?? "Capability"),
  ]));
  const relatedIds = new Set(relationships.flatMap((relationship) => [
    String(relationship.source_capability_id ?? ""),
    String(relationship.target_capability_id ?? ""),
  ]).filter(Boolean));
  const connectedCapabilities = capabilities.filter((capability) => relatedIds.has(String(capability.capability_id ?? capability.id ?? "")));
  const isolatedCapabilities = capabilities.filter((capability) => !relatedIds.has(String(capability.capability_id ?? capability.id ?? "")));
  const relationCounts = relationships.reduce((acc, relationship) => {
    const type = String(relationship.relationship_type ?? "relationship");
    acc.set(type, (acc.get(type) ?? 0) + 1);
    return acc;
  }, new Map<string, number>());

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <Metric label="Capabilities" value={capabilities.length || (loading ? "..." : 0)} />
          <Metric label="Relationships" value={isLoading ? "..." : relationships.length} tone="#0284c7" />
          <Metric label="Connected" value={connectedCapabilities.length} tone="#15803d" />
          <Metric label="Isolated" value={isolatedCapabilities.length} tone={isolatedCapabilities.length ? "#b45309" : "#15803d"} />
        </div>
        {error ? <SmallError error={error} /> : null}
      </section>

      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Relationship Map</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {relationships.map((relationship, index) => {
            const source = String(relationship.source_capability_id ?? "");
            const target = String(relationship.target_capability_id ?? "");
            const type = String(relationship.relationship_type ?? "relationship");
            return (
              <article key={String(relationship.id ?? `${source}-${target}-${type}-${index}`)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-primary)", fontWeight: 850, fontSize: 12, marginBottom: 8 }}>
                  <GitBranch size={14} />
                  {type}
                </div>
                <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                  <GraphNodeLabel id={source} label={names.get(source)} />
                  <div style={{ color: "var(--color-outline)", fontSize: 12, paddingLeft: 10 }}>to</div>
                  <GraphNodeLabel id={target} label={names.get(target)} />
                </div>
                {relationship.inheritance_policy ? <div style={{ color: "var(--color-outline)", fontSize: 12, marginTop: 8 }}>inheritance: {String(relationship.inheritance_policy)}</div> : null}
              </article>
            );
          })}
          {!isLoading && relationships.length === 0 && <EmptyPanel label="No capability relationships returned by IAM." />}
          {isLoading && <EmptyPanel label="Loading capability relationships..." />}
        </div>
      </section>

      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Relationship Types</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Array.from(relationCounts.entries()).map(([type, count]) => (
            <span key={type} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "5px 9px", fontSize: 12, fontWeight: 800 }}>
              {type}: {count}
            </span>
          ))}
          {relationCounts.size === 0 && <span style={{ color: "var(--color-outline)", fontSize: 13 }}>No relationship types found.</span>}
        </div>
      </section>
    </div>
  );
}

function GraphNodeLabel({ id, label }: { id: string; label?: string }) {
  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, minWidth: 0 }}>
      <strong style={{ fontSize: 13 }}>{label ?? (id || "Unknown capability")}</strong>
      <div style={{ color: "var(--color-outline)", fontSize: 11, overflowWrap: "anywhere", marginTop: 3 }}>{id}</div>
    </div>
  );
}

function AuthzPanel({ permissions }: { permissions: IdentityRow[] }) {
  const [form, setForm] = useState<AuthzCheckRequest>({ user_id: "", capability_id: "", action: "" });
  const [result, setResult] = useState<AuthzCheckResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setResult(await checkAuthorization(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.9fr)", gap: 16, alignItems: "start" }}>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Authorization Check</h2>
        <div style={{ display: "grid", gap: 10 }}>
          <IdentityInput label="User ID" value={form.user_id} onChange={(value) => setForm({ ...form, user_id: value })} placeholder="UUID" />
          <IdentityInput label="Capability ID" value={form.capability_id} onChange={(value) => setForm({ ...form, capability_id: value })} placeholder="capability id" />
          <IdentityInput label="Action" value={form.action} onChange={(value) => setForm({ ...form, action: value })} placeholder="workflow:execute" />
          <IdentityInput label="Resource Type" value={form.resource_type ?? ""} onChange={(value) => setForm({ ...form, resource_type: value })} placeholder="workflow" />
          <IdentityInput label="Resource ID" value={form.resource_id ?? ""} onChange={(value) => setForm({ ...form, resource_id: value })} placeholder="resource id" />
          <IdentityInput label="Requesting Capability ID" value={form.requesting_capability_id ?? ""} onChange={(value) => setForm({ ...form, requesting_capability_id: value })} placeholder="optional" />
          <button type="button" className="btn-primary" disabled={busy || !form.user_id || !form.capability_id || !form.action} onClick={() => void submit()}>{busy ? "Checking..." : "Check Authorization"}</button>
        </div>
      </section>
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Result</h2>
        {error ? <SmallError error={error} /> : null}
        {!result ? <EmptyPanel label="Submit a check to see the decision." /> : (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, border: `1px solid ${result.allowed ? "rgba(21,128,61,0.28)" : "rgba(185,28,28,0.28)"}`, background: result.allowed ? "rgba(240,253,244,0.82)" : "rgba(254,242,242,0.82)", borderRadius: 8, padding: 14 }}>
              {result.allowed ? <ShieldCheck size={28} color="#15803d" /> : <ShieldX size={28} color="#b91c1c" />}
              <div>
                <strong style={{ color: result.allowed ? "#15803d" : "#b91c1c" }}>{result.allowed ? "ALLOWED" : "DENIED"}</strong>
                {result.reason && <div style={{ color: "var(--color-outline)", fontSize: 13, marginTop: 3 }}>{result.reason}</div>}
              </div>
            </div>
            <ChipList label="Roles" items={result.roles ?? []} />
            <ChipList label="Permissions" items={result.permissions ?? []} />
            {result.source && <Fact label="Source" value={result.source} />}
          </div>
        )}
      </section>
      <section className="card" style={{ padding: 18, gridColumn: "1 / -1" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>Permission Catalog</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {permissions.slice(0, 80).map((permission, index) => <span key={String(permission.id ?? index)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "4px 8px", fontSize: 12 }}>{valueText(permission.permission_key ?? permission.name)}</span>)}
        </div>
      </section>
    </div>
  );
}

function IdentityInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }} />
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone?: string }) {
  return (
    <div style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 10, background: "#fff" }}>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 4, color: tone ?? "var(--color-text)", fontWeight: 850, fontSize: 15 }}>{valueText(value)}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 3, fontWeight: 750, fontSize: 13, overflowWrap: "anywhere" }}>{valueText(value)}</div>
    </div>
  );
}

function ChipList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div style={{ color: "var(--color-outline)", fontSize: 11, textTransform: "uppercase", fontWeight: 800, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{items.map((item) => <span key={item} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "4px 8px", fontSize: 12 }}>{item}</span>)}</div>
    </div>
  );
}

function ErrorBanner({ error }: { error: unknown }) {
  return (
    <section className="card" style={{ padding: 16, marginBottom: 18, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.82)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#991b1b", fontWeight: 850 }}>
        <CircleAlert size={16} />
        Could not load IAM data.
      </div>
      <div style={{ color: "#7f1d1d", fontSize: 13, marginTop: 5 }}>{error instanceof Error ? error.message : String(error)}</div>
    </section>
  );
}

function SmallError({ error }: { error: unknown }) {
  return <div style={{ border: "1px solid rgba(185,28,28,0.24)", background: "rgba(254,242,242,0.72)", color: "#7f1d1d", borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12 }}>{error instanceof Error ? error.message : String(error)}</div>;
}

function EmptyPanel({ label }: { label: string }) {
  return <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 18, color: "var(--color-outline)", fontSize: 13, textAlign: "center" }}>{label}</div>;
}

function pick(row: IdentityRow, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return undefined;
}

function formatCell(value: unknown) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
  return valueText(value);
}

function titleFor(view: IdentityView) {
  return viewCopy[view]?.title ?? "Identity";
}
