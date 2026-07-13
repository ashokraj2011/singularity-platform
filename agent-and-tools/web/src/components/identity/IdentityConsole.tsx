"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import useSWR from "swr";
import { CircleAlert, GitBranch, ShieldCheck, ShieldX, Users } from "lucide-react";
import {
  addRolePermission,
  addTeamMember,
  asRows,
  assignUserRole,
  checkAuthorization,
  createIdentity,
  createMcpServer,
  deleteMcpServer,
  deletePermission,
  listCapabilityRelationships,
  listIdentity,
  listMcpServers,
  listRolePermissions,
  listUserRoles,
  listUserTeams,
  removeRolePermission,
  removeTeamMember,
  revokeUserRole,
  updateIdentity,
  updateMcpServer,
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
    { label: "Category", keys: ["category", "scope", "resource_type"] },
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
// A dropdown sourced from live IAM data. `valueKey` is the row field used as the
// submitted value (e.g. "bu_key"); `labelKeys` build the human label. Static
// options are merged with live rows so first-run IAM still has usable choices.
type OptionSpec = {
  view: IdentityView;
  valueKey: string;
  labelKeys: string[];
  distinct?: boolean;
  excludeCurrent?: boolean;
  staticOptions?: Array<{ value: string; label: string }>;
};
// A relationship field is NOT part of the entity body — after the entity is
// saved we call `apply(entityId, value)` once per selected value (e.g. add the
// new user to a team, or assign each chosen role). `multi` renders a multiselect.
type RelationSpec = OptionSpec & { multi?: boolean; apply: (entityId: string, value: string) => Promise<unknown> };
type FieldSpec = {
  key: string; label: string; required?: boolean; placeholder?: string; textarea?: boolean; hint?: string;
  select?: OptionSpec;     // dropdown whose value is written into the create/edit body
  relation?: RelationSpec; // dropdown/multiselect wired to a relationship endpoint after save
  // Free-text input + a <datalist> of suggestions = the distinct `key` values
  // across existing `view` rows. Used for the permission "category" field, which
  // is a free string (no categories table) — suggest existing ones, allow new.
  datalist?: { view: IdentityView; key: string };
};

const PERMISSION_CATEGORY_OPTIONS = [
  { value: "workflow", label: "Workflow" },
  { value: "agent", label: "Agent" },
  { value: "tool", label: "Tool" },
  { value: "context", label: "Context" },
  { value: "model", label: "Model" },
  { value: "capability", label: "Capability" },
  { value: "governance", label: "Governance" },
  { value: "admin", label: "Administration" },
];

const ROLE_SCOPE_OPTIONS = [
  { value: "platform", label: "Platform" },
  { value: "capability", label: "Capability" },
];

const createForms: Partial<Record<IdentityView, { singular: string; fields: FieldSpec[] }>> = {
  "business-units": {
    singular: "Business Unit",
    fields: [
      { key: "bu_key", label: "Key", required: true, placeholder: "engineering", hint: "Unique identifier; can't be changed later." },
      { key: "name", label: "Name", required: true, placeholder: "Engineering" },
      { key: "description", label: "Description", textarea: true },
      { key: "parent_bu_id", label: "Parent business unit", placeholder: "— none —", hint: "Optional. Stores the selected business unit UUID.", select: { view: "business-units", valueKey: "id", labelKeys: ["name", "bu_key"], excludeCurrent: true } },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  teams: {
    singular: "Team",
    fields: [
      { key: "team_key", label: "Key", required: true, placeholder: "platform-eng" },
      { key: "name", label: "Name", required: true, placeholder: "Platform Engineering" },
      { key: "bu_key", label: "Business Unit", placeholder: "— none —", hint: "Owning business unit.", select: { view: "business-units", valueKey: "bu_key", labelKeys: ["name", "bu_key"] } },
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
      { key: "auth_provider", label: "Auth provider", placeholder: "local", hint: "How the user signs in (local, oidc, …)." },
      { key: "team_id", label: "Team", hint: "Adds the new user to this team.", relation: { view: "teams", valueKey: "id", labelKeys: ["name", "team_key"], apply: (userId, teamId) => addTeamMember(teamId, userId) } },
      { key: "role_keys", label: "Platform roles", hint: "Roles granted to the user (multi-select).", relation: { view: "roles", valueKey: "role_key", labelKeys: ["name", "role_key"], multi: true, apply: (userId, roleKey) => assignUserRole(userId, roleKey) } },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  roles: {
    singular: "Role",
    fields: [
      { key: "role_key", label: "Key", required: true, placeholder: "reviewer" },
      { key: "name", label: "Name", required: true, placeholder: "Reviewer" },
      { key: "description", label: "Description", textarea: true },
      { key: "role_scope", label: "Scope", placeholder: "Choose scope", select: { view: "roles", valueKey: "role_scope", labelKeys: ["role_scope"], distinct: true, staticOptions: ROLE_SCOPE_OPTIONS } },
    ],
  },
  permissions: {
    singular: "Permission",
    fields: [
      { key: "permission_key", label: "Key", required: true, placeholder: "workflow:review", hint: "Immutable action key that code/policies match on. Convention: resource:action. A new key doesn't gate anything until something checks it." },
      { key: "category", label: "Category", placeholder: "Choose category", hint: "Groups the key in the catalog and follows the platform permission taxonomy.", select: { view: "permissions", valueKey: "category", labelKeys: ["category"], distinct: true, staticOptions: PERMISSION_CATEGORY_OPTIONS } },
      { key: "description", label: "Description", textarea: true },
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
      { key: "owner_bu_key", label: "Owner business unit", placeholder: "— none —", select: { view: "business-units", valueKey: "bu_key", labelKeys: ["name", "bu_key"] } },
      { key: "owner_team_key", label: "Owner team", placeholder: "— none —", select: { view: "teams", valueKey: "team_key", labelKeys: ["name", "team_key"] } },
    ],
  },
};

function buildCreateBody(fields: FieldSpec[], values: Record<string, string | string[]>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.relation) continue; // relationship fields are applied after save, not in the body
    const val = values[f.key];
    const raw = (typeof val === "string" ? val : "").trim();
    if (!raw) continue;
    body[f.key] = f.key === "tags" ? raw.split(",").map((t) => t.trim()).filter(Boolean) : raw;
  }
  return body;
}

// First non-empty labelKey value on a row, for dropdown option text.
function optionText(row: IdentityRow, labelKeys: string[]): string {
  for (const k of labelKeys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v);
  }
  return "(unnamed)";
}

// Editable fields per entity — a subset of create (keys are immutable, and the
// BU/Team update schemas are `extra: forbid` so ONLY these keys may be sent).
// `idKey` is the row field used in the PATCH URL (capability keys off its
// capability_id, others off the UUID id). Roles are absent — no PATCH endpoint.
const editForms: Partial<Record<IdentityView, { idKey: string; fields: FieldSpec[] }>> = {
  "business-units": {
    idKey: "id",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "description", label: "Description", textarea: true },
      { key: "parent_bu_id", label: "Parent business unit", placeholder: "— none —", hint: "Optional. Stores the selected business unit UUID.", select: { view: "business-units", valueKey: "id", labelKeys: ["name", "bu_key"], excludeCurrent: true } },
    ],
  },
  teams: {
    idKey: "id",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "description", label: "Description", textarea: true },
      { key: "parent_team_id", label: "Parent team ID", placeholder: "(optional UUID)" },
    ],
  },
  users: {
    idKey: "id",
    fields: [
      { key: "display_name", label: "Display name" },
      { key: "status", label: "Status", placeholder: "active | suspended" },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  capabilities: {
    idKey: "capability_id",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "description", label: "Description", textarea: true },
      { key: "status", label: "Status", placeholder: "active | suspended" },
      { key: "visibility", label: "Visibility", placeholder: "private | shared" },
      { key: "tags", label: "Tags", placeholder: "comma, separated" },
    ],
  },
  // Only the human-facing metadata is editable — the permission_key is the
  // enforcement anchor (immutable server-side), so it isn't offered as a field.
  // PATCH targets /permissions/{permission_key}, hence idKey.
  permissions: {
    idKey: "permission_key",
    fields: [
      { key: "category", label: "Category", placeholder: "Choose category", select: { view: "permissions", valueKey: "category", labelKeys: ["category"], distinct: true, staticOptions: PERMISSION_CATEGORY_OPTIONS } },
      { key: "description", label: "Description", textarea: true },
    ],
  },
};

function initialValues(fields: FieldSpec[], row: IdentityRow): Record<string, string> {
  const v: Record<string, string> = {};
  for (const f of fields) {
    const raw = row[f.key];
    if (raw == null) continue;
    v[f.key] = Array.isArray(raw) ? raw.join(", ") : String(raw);
  }
  return v;
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
  const [editing, setEditing] = useState<IdentityRow | null>(null);
  const [managing, setManaging] = useState<IdentityRow | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const form = createForms[view];
  const editable = Boolean(editForms[view]) && Boolean(onCreated);
  // Views with a per-row management modal (relationship editing) rather than a
  // flat field edit. Users manage teams+roles; roles manage their permission
  // grants. These render an actions column even when the entity has no PATCH
  // (roles have no PATCH endpoint, so `editable` is false for them).
  const manageable = view === "users" || view === "roles";
  const colCount = tableColumns.length + (editable || manageable ? 1 : 0);

  // Permission catalog delete. IAM blocks (409) if the key is still granted to a
  // role, so surface that message inline rather than as a silent failure.
  async function removePermission(row: IdentityRow) {
    const key = String(row.permission_key ?? row.key ?? "");
    if (!key || !onCreated) return;
    if (!window.confirm(`Delete permission "${key}"? It is removed from the catalog. Keys shipped in the default seed reappear on the next IAM restart.`)) return;
    setDeletingKey(key); setRowError(null);
    try { await deletePermission(key); onCreated(); }
    catch (e) { setRowError(e instanceof Error ? e.message : String(e)); }
    finally { setDeletingKey(null); }
  }

  return (
    <section className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: 18, borderBottom: "1px solid var(--color-outline-variant)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--color-outline)", fontSize: 12 }}>{loading ? "Loading" : `${rows.length} shown`}</span>
          {view === "capabilities" ? (
            // Creating a capability means onboarding it (agent team + learning +
            // starter workflow), not registering a bare IAM record — so route to
            // the Bootstrap Capability factory instead of the quick-create modal.
            <Link href="/capabilities" className="btn-primary" style={{ padding: "6px 12px", fontSize: 13, textDecoration: "none" }}>
              ＋ Onboard Capability
            </Link>
          ) : form && onCreated ? (
            <button type="button" className="btn-primary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setCreating(true)}>
              ＋ New {form.singular}
            </button>
          ) : null}
        </div>
      </div>
      {creating && form && onCreated ? (
        <EntityFormModal view={view} mode="create" onClose={() => setCreating(false)} onSaved={() => { setCreating(false); onCreated(); }} />
      ) : null}
      {editing && editable && onCreated ? (
        <EntityFormModal view={view} mode="edit" row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onCreated(); }} />
      ) : null}
      {managing && view === "users" ? (
        <ManageUserModal user={managing} onClose={() => setManaging(null)} />
      ) : null}
      {managing && view === "roles" ? (
        <ManageRolePermissionsModal role={managing} onClose={() => setManaging(null)} />
      ) : null}
      {rowError ? <div style={{ padding: "10px 18px 0" }}><SmallError error={rowError} /></div> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {tableColumns.map((column) => <th key={column.label} className="text-left px-4 py-3 font-medium text-slate-600">{column.label}</th>)}
              {editable || manageable ? <th className="px-4 py-3" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={String(row.id ?? index)} className="hover:bg-slate-50">
                {tableColumns.map((column) => <td key={column.label} className="px-4 py-3 text-slate-700">{formatCell(pick(row, column.keys))}</td>)}
                {editable || manageable ? (
                  <td className="px-4 py-3 text-right">
                    <div style={{ display: "inline-flex", gap: 6, justifyContent: "flex-end" }}>
                      {view === "users" ? (
                        <button type="button" onClick={() => setManaging(row)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", color: "var(--color-on-surface-variant)", cursor: "pointer" }}>Teams &amp; roles</button>
                      ) : null}
                      {view === "roles" ? (
                        // Roles have no PATCH endpoint (not `editable`), but their access —
                        // the permission grants that make a role mean something — is managed
                        // through a relationship modal, same pattern as user teams/roles.
                        <button type="button" onClick={() => setManaging(row)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", color: "var(--color-on-surface-variant)", cursor: "pointer" }}>Permissions</button>
                      ) : null}
                      {view === "capabilities" ? (
                        // Capabilities have a dedicated full-screen editor (owner, agents,
                        // architecture, lifecycle) — send Edit there instead of the flat modal.
                        <Link href={`/capabilities/${encodeURIComponent(String(row.capability_id ?? row.id ?? ""))}`} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", color: "var(--color-primary)", cursor: "pointer", textDecoration: "none" }}>Edit</Link>
                      ) : editable ? (
                        <button type="button" onClick={() => setEditing(row)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", color: "var(--color-primary)", cursor: "pointer" }}>Edit</button>
                      ) : null}
                      {view === "permissions" && onCreated ? (
                        <button type="button" disabled={deletingKey === String(row.permission_key ?? row.key ?? "")} onClick={() => void removePermission(row)} style={{ border: "1px solid rgba(185,28,28,0.28)", borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", color: "#b91c1c", cursor: "pointer" }}>{deletingKey === String(row.permission_key ?? row.key ?? "") ? "Deleting…" : "Delete"}</button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={colCount} className="px-4 py-12 text-center text-slate-400">No records found.</td></tr>}
            {loading && <tr><td colSpan={colCount} className="px-4 py-12 text-center text-slate-400">Loading...</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const fieldInputStyle: CSSProperties = { border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500, background: "#fff", width: "100%" };

function EntityFormModal({ view, mode, row, onClose, onSaved }: { view: IdentityView; mode: "create" | "edit"; row?: IdentityRow; onClose: () => void; onSaved: () => void }) {
  const singular = createForms[view]?.singular ?? titleFor(view);
  const editSpec = editForms[view];
  const fields = mode === "edit" ? (editSpec?.fields ?? []) : (createForms[view]?.fields ?? []);
  const [values, setValues] = useState<Record<string, string | string[]>>(() => (mode === "edit" && row ? initialValues(fields, row) : {}));
  const [options, setOptions] = useState<Record<string, { value: string; label: string }[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missingRequired = fields.some((f) => f.required && !(typeof values[f.key] === "string" ? (values[f.key] as string) : "").trim());

  // Load dropdown/relationship options from live IAM data so operators pick real
  // entities instead of typing keys that may not exist.
  useEffect(() => {
    let cancelled = false;
    const sourced = fields.filter((f) => f.select || f.relation || f.datalist);
    if (sourced.length === 0) return;
    void Promise.all(sourced.map(async (f) => {
      try {
        // datalist: suggestions = the distinct values of `key` across `view` rows.
        if (f.datalist) {
          const page = await listIdentity(f.datalist.view, 300);
          const seen = new Set<string>();
          const opts: { value: string; label: string }[] = [];
          for (const r of page.items ?? []) {
            const v = String(r[f.datalist.key] ?? "").trim();
            if (v && !seen.has(v)) { seen.add(v); opts.push({ value: v, label: v }); }
          }
          opts.sort((a, b) => a.value.localeCompare(b.value));
          return [f.key, opts] as const;
        }
        const spec = (f.select ?? f.relation)!;
        const currentEntityId = mode === "edit" && row
          ? String(row[editSpec?.idKey ?? "id"] ?? row.id ?? "")
          : "";
        const page = await listIdentity(spec.view, 200);
        const liveOpts = (page.items ?? [])
          .filter((r) => !(spec.excludeCurrent && currentEntityId && String(r.id ?? "") === currentEntityId))
          .map((r) => ({ value: String(r[spec.valueKey] ?? ""), label: optionText(r, spec.labelKeys) }))
          .filter((o) => o.value);
        const merged = [...(spec.staticOptions ?? []), ...liveOpts];
        const seen = new Set<string>();
        const opts = merged.filter((option) => {
          if (!option.value || (spec.distinct && seen.has(option.value))) return false;
          seen.add(option.value);
          return true;
        });
        return [f.key, opts] as const;
      } catch {
        return [f.key, f.select?.staticOptions ?? []] as const;
      }
    })).then((entries) => { if (!cancelled) setOptions(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, mode]);

  function setScalar(key: string, v: string) { setValues((prev) => ({ ...prev, [key]: v })); }
  function toggleMulti(key: string, v: string) {
    setValues((prev) => {
      const cur = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      return { ...prev, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = buildCreateBody(fields, values);
      let entityId = mode === "edit" && row ? String(row[editSpec?.idKey ?? "id"] ?? row.id ?? "") : "";
      if (mode === "edit" && row && editSpec) {
        await updateIdentity(view, entityId, body);
      } else {
        const created = await createIdentity(view, body);
        entityId = String((created && (created.id ?? (created as Record<string, unknown>).user_id)) ?? "");
      }
      // Apply relationship fields (add-to-team, assign-roles) once the entity exists.
      const relations = fields.filter((f) => f.relation);
      if (relations.length && entityId) {
        const failures: string[] = [];
        for (const f of relations) {
          const raw = values[f.key];
          const vals = Array.isArray(raw) ? raw : (typeof raw === "string" && raw ? [raw] : []);
          for (const v of vals) {
            try { await f.relation!.apply(entityId, v); }
            catch (e) { failures.push(`${f.label} "${v}": ${e instanceof Error ? e.message : String(e)}`); }
          }
        }
        if (failures.length) {
          setError(`${singular} saved, but some links failed:\n${failures.join("\n")}`);
          setBusy(false);
          return; // keep the modal open so the operator can see what didn't wire
        }
      }
      onSaved(); // unmounts this modal + refreshes the list
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{mode === "edit" ? "Edit" : "New"} {singular}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-outline)" }}>Requires super-admin. Fields marked * are required.{mode === "edit" ? " Blank fields are left unchanged." : ""}</p>
        <div style={{ display: "grid", gap: 10 }}>
          {fields.map((f) => {
            const opts = options[f.key] ?? [];
            const isDropdown = Boolean(f.select || (f.relation && !f.relation.multi));
            const isMulti = Boolean(f.relation?.multi);
            const cur = values[f.key];
            const dropdownOptions = isDropdown && typeof cur === "string" && cur && !opts.some((o) => o.value === cur)
              ? [{ value: cur, label: `${cur} (current)` }, ...opts]
              : opts;
            return (
              <label key={f.key} style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
                {f.label}{f.required ? " *" : ""}
                {isMulti ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 8, minHeight: 40 }}>
                    {opts.length === 0
                      ? <span style={{ fontWeight: 500, color: "var(--color-outline)", fontSize: 12 }}>No options available.</span>
                      : opts.map((o) => {
                          const on = Array.isArray(cur) && cur.includes(o.value);
                          return (
                            <button type="button" key={o.value} onClick={() => toggleMulti(f.key, o.value)}
                              style={{ border: `1px solid ${on ? "var(--color-primary)" : "var(--color-outline-variant)"}`, background: on ? "var(--color-primary-dim)" : "#fff", color: on ? "var(--color-primary)" : "var(--color-on-surface-variant)", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                              {on ? "✓ " : ""}{o.label}
                            </button>
                          );
                        })}
                  </div>
                ) : isDropdown ? (
                  <select value={typeof cur === "string" ? cur : ""} onChange={(e) => setScalar(f.key, e.target.value)} style={fieldInputStyle}>
                    <option value="">{f.placeholder ?? "— none —"}</option>
                    {dropdownOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.datalist ? (
                  <>
                    <input list={`dl-${f.key}`} value={typeof cur === "string" ? cur : ""} onChange={(e) => setScalar(f.key, e.target.value)} placeholder={f.placeholder} style={fieldInputStyle} />
                    <datalist id={`dl-${f.key}`}>
                      {opts.map((o) => <option key={o.value} value={o.value} />)}
                    </datalist>
                  </>
                ) : f.textarea ? (
                  <textarea value={typeof cur === "string" ? cur : ""} onChange={(e) => setScalar(f.key, e.target.value)} placeholder={f.placeholder} rows={3} style={{ ...fieldInputStyle, resize: "vertical" }} />
                ) : (
                  <input value={typeof cur === "string" ? cur : ""} onChange={(e) => setScalar(f.key, e.target.value)} placeholder={f.placeholder} style={fieldInputStyle} />
                )}
                {f.hint ? <span style={{ fontWeight: 500, color: "var(--color-outline)", fontSize: 11 }}>{f.hint}</span> : null}
              </label>
            );
          })}
        </div>
        {error ? <div style={{ marginTop: 12, whiteSpace: "pre-wrap" }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || missingRequired}>{busy ? "Saving…" : mode === "edit" ? "Save changes" : `Create ${singular}`}</button>
        </div>
      </div>
    </div>
  );
}

// Defensive extractors — the IAM list endpoints for a user's teams/roles may
// return membership rows or entity rows, so we read the id/key under a few names.
function teamRowId(r: Record<string, unknown>): string { return String(r.id ?? r.team_id ?? r.teamId ?? ""); }
function teamRowLabel(r: Record<string, unknown>): string { return String(r.name ?? r.team_name ?? r.team_key ?? teamRowId(r)); }
function roleRowKey(r: Record<string, unknown>): string { return String(r.role_key ?? r.key ?? r.roleKey ?? ""); }
function roleRowLabel(r: Record<string, unknown>): string { return String(r.name ?? r.role_name ?? roleRowKey(r)); }
function permRowKey(p: Record<string, unknown>): string { return String(p.permission_key ?? p.key ?? p.permissionKey ?? ""); }
function permRowLabel(p: Record<string, unknown>): string { const k = permRowKey(p); const n = String(p.name ?? ""); return n && n !== k ? `${n} · ${k}` : k; }

// Manage a user's team memberships and platform-role assignments after creation.
// Add/remove wire directly to the IAM relationship endpoints; the list refreshes
// after each change so the operator always sees the true state.
function ManageUserModal({ user, onClose }: { user: IdentityRow; onClose: () => void }) {
  const userId = String(user.id ?? "");
  const userLabel = String(user.display_name ?? user.name ?? user.email ?? userId);
  const [teams, setTeams] = useState<Record<string, unknown>[]>([]);
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [teamOpts, setTeamOpts] = useState<{ value: string; label: string }[]>([]);
  const [roleOpts, setRoleOpts] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [t, r] = await Promise.all([listUserTeams(userId), listUserRoles(userId)]);
    setTeams(asRows(t)); setRoles(asRows(r));
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [t, r, teamsPage, rolesPage] = await Promise.all([
          listUserTeams(userId), listUserRoles(userId),
          listIdentity("teams", 200), listIdentity("roles", 200),
        ]);
        if (cancelled) return;
        setTeams(asRows(t)); setRoles(asRows(r));
        setTeamOpts((teamsPage.items ?? []).map((x) => ({ value: String(x.id ?? ""), label: optionText(x, ["name", "team_key"]) })).filter((o) => o.value));
        setRoleOpts((rolesPage.items ?? []).map((x) => ({ value: String(x.role_key ?? x.key ?? ""), label: optionText(x, ["name", "role_key"]) })).filter((o) => o.value));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const currentTeamIds = new Set(teams.map(teamRowId));
  const currentRoleKeys = new Set(roles.map(roleRowKey));
  const addableTeams = teamOpts.filter((o) => !currentTeamIds.has(o.value));
  const addableRoles = roleOpts.filter((o) => !currentRoleKeys.has(o.value));

  const chip = (label: string, onRemove: () => void) => (
    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface-low)", borderRadius: 999, padding: "3px 6px 3px 10px", fontSize: 12, fontWeight: 700, color: "var(--color-on-surface)" }}>
      {label}
      <button type="button" disabled={busy} onClick={onRemove} aria-label={`Remove ${label}`} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
    </span>
  );

  const addPicker = (options: { value: string; label: string }[], onAdd: (v: string) => void, placeholder: string) => (
    <select value="" disabled={busy || options.length === 0} onChange={(e) => { if (e.target.value) onAdd(e.target.value); }} style={{ ...fieldInputStyle, maxWidth: 260 }}>
      <option value="">{options.length === 0 ? "— nothing to add —" : placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Manage {userLabel}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--color-outline)" }}>Teams and platform roles for this user. Changes apply immediately (super-admin).</p>

        {loading ? <p style={{ fontSize: 13, color: "var(--color-outline)" }}>Loading…</p> : (
          <div style={{ display: "grid", gap: 18 }}>
            <section>
              <div className="label-xs" style={{ marginBottom: 8 }}>Teams</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {teams.length === 0 ? <span style={{ fontSize: 12, color: "var(--color-outline)" }}>Not a member of any team.</span>
                  : teams.map((t) => chip(teamRowLabel(t), () => void run(() => removeTeamMember(teamRowId(t), userId))))}
              </div>
              {addPicker(addableTeams, (v) => void run(() => addTeamMember(v, userId)), "Add to team…")}
            </section>
            <section>
              <div className="label-xs" style={{ marginBottom: 8 }}>Platform roles</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {roles.length === 0 ? <span style={{ fontSize: 12, color: "var(--color-outline)" }}>No roles assigned.</span>
                  : roles.map((r) => chip(roleRowLabel(r), () => void run(() => revokeUserRole(userId, roleRowKey(r)))))}
              </div>
              {addPicker(addableRoles, (v) => void run(() => assignUserRole(userId, v)), "Assign role…")}
            </section>
          </div>
        )}
        {error ? <div style={{ marginTop: 14 }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Manage the permission grants on a single role. A role is just a named bag of
// permission keys; this modal is where an operator gives a role its access —
// e.g. create a "BA"/"Architect"/"admin" role, then grant it the permissions it
// needs. Mirrors ManageUserModal's chip+picker relationship pattern, backed by
// IAM /roles/{key}/permissions (add/remove are super-admin gated server-side).
function ManageRolePermissionsModal({ role, onClose }: { role: IdentityRow; onClose: () => void }) {
  const roleKey = roleRowKey(role);
  const roleLabel = roleRowLabel(role);
  const [perms, setPerms] = useState<Record<string, unknown>[]>([]);
  const [permOpts, setPermOpts] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const p = await listRolePermissions(roleKey);
    setPerms(asRows(p));
  }

  // Load the role's current grants plus the full permission catalog so the
  // operator picks from real permission keys rather than typing them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [p, catalog] = await Promise.all([
          listRolePermissions(roleKey),
          listIdentity("permissions", 300),
        ]);
        if (cancelled) return;
        setPerms(asRows(p));
        setPermOpts((catalog.items ?? []).map((x) => ({ value: permRowKey(x), label: permRowLabel(x) })).filter((o) => o.value));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [roleKey]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const currentKeys = new Set(perms.map(permRowKey));
  const addablePerms = permOpts.filter((o) => !currentKeys.has(o.value));

  const chip = (label: string, onRemove: () => void) => (
    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--color-outline-variant)", background: "var(--color-surface-low)", borderRadius: 999, padding: "3px 6px 3px 10px", fontSize: 12, fontWeight: 700, color: "var(--color-on-surface)" }}>
      {label}
      <button type="button" disabled={busy} onClick={onRemove} aria-label={`Remove ${label}`} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
    </span>
  );

  const addPicker = (options: { value: string; label: string }[], onAdd: (v: string) => void, placeholder: string) => (
    <select value="" disabled={busy || options.length === 0} onChange={(e) => { if (e.target.value) onAdd(e.target.value); }} style={{ ...fieldInputStyle, maxWidth: 320 }}>
      <option value="">{options.length === 0 ? "— nothing to add —" : placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Permissions · {roleLabel}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--color-outline)" }}>Access granted by the <strong>{roleKey}</strong> role. Assign these to users (or use as a workflow role) to grant this access. Changes apply immediately (super-admin).</p>

        {loading ? <p style={{ fontSize: 13, color: "var(--color-outline)" }}>Loading…</p> : (
          <div style={{ display: "grid", gap: 18 }}>
            <section>
              <div className="label-xs" style={{ marginBottom: 8 }}>Granted permissions</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {perms.length === 0 ? <span style={{ fontSize: 12, color: "var(--color-outline)" }}>No permissions granted — this role grants nothing yet.</span>
                  : perms.map((p) => chip(permRowLabel(p), () => void run(() => removeRolePermission(roleKey, permRowKey(p)))))}
              </div>
              {addPicker(addablePerms, (v) => void run(() => addRolePermission(roleKey, v)), "Grant permission…")}
            </section>
          </div>
        )}
        {error ? <div style={{ marginTop: 14 }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Done</button>
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
  const [editing, setEditing] = useState<IdentityRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function remove(server: IdentityRow) {
    const id = String(server.id ?? "");
    if (!id) return;
    if (!window.confirm(`Delete MCP server "${valueText(server.name)}"? This cannot be undone.`)) return;
    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteMcpServer(id);
      void mutate();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  const actionBtn = { borderRadius: 7, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#fff", cursor: "pointer" };

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

      {deleteError ? <SmallError error={deleteError} /> : null}

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
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {serverRows.map((s, index) => {
                const id = String(s.id ?? "");
                return (
                  <tr key={id || index} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-700">{valueText(s.name)}</td>
                    <td className="px-4 py-3 text-slate-700">{valueText(s.base_url)}</td>
                    <td className="px-4 py-3 text-slate-700">{valueText(s.protocol)}</td>
                    <td className="px-4 py-3 text-slate-700">{valueText(s.status)}</td>
                    <td className="px-4 py-3 text-right" style={{ whiteSpace: "nowrap" }}>
                      <button type="button" onClick={() => setEditing(s)} style={{ ...actionBtn, border: "1px solid var(--color-outline-variant)", color: "var(--color-primary)" }}>Edit</button>
                      <button type="button" onClick={() => void remove(s)} disabled={deletingId === id} style={{ ...actionBtn, border: "1px solid rgba(185,28,28,0.28)", color: "#b91c1c", marginLeft: 8 }}>{deletingId === id ? "Deleting…" : "Delete"}</button>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && serverRows.length === 0 && <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-400">No MCP servers registered for this capability.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {creating && effectiveCapId ? (
        <McpServerFormModal mode="create" capabilityId={effectiveCapId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void mutate(); }} />
      ) : null}
      {editing ? (
        <McpServerFormModal mode="edit" server={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void mutate(); }} />
      ) : null}
    </div>
  );
}

function McpServerFormModal({ mode, capabilityId, server, onClose, onSaved }: { mode: "create" | "edit"; capabilityId?: string; server?: IdentityRow; onClose: () => void; onSaved: () => void }) {
  const isEdit = mode === "edit";
  const [values, setValues] = useState<Record<string, string>>((): Record<string, string> => (isEdit && server ? {
    name: String(server.name ?? ""),
    base_url: String(server.base_url ?? ""),
    protocol: String(server.protocol ?? "MCP_HTTP"),
    protocol_version: server.protocol_version != null ? String(server.protocol_version) : "",
    description: server.description != null ? String(server.description) : "",
    status: server.status != null ? String(server.status) : "",
    tags: Array.isArray(server.tags) ? (server.tags as unknown[]).join(", ") : "",
    bearer_token: "",
  } : { protocol: "MCP_HTTP" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (v: string) => setValues((prev) => ({ ...prev, [k]: v }));
  const name = (values.name ?? "").trim();
  const baseUrl = (values.base_url ?? "").trim();
  const token = (values.bearer_token ?? "").trim();
  // Create requires a token (≥8). Edit keeps the current token unless a new one (≥8) is entered.
  const tokenInvalid = isEdit ? token.length > 0 && token.length < 8 : token.length < 8;
  const invalid = !name || !baseUrl || tokenInvalid;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, base_url: baseUrl, protocol: values.protocol || "MCP_HTTP" };
      if (token) body.bearer_token = token;
      const desc = (values.description ?? "").trim();
      const ver = (values.protocol_version ?? "").trim();
      const tags = (values.tags ?? "").trim();
      const status = (values.status ?? "").trim();
      if (desc) body.description = desc;
      if (ver) body.protocol_version = ver;
      if (tags) body.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (isEdit && status) body.status = status;
      if (isEdit && server) {
        await updateMcpServer(String(server.id ?? ""), body);
      } else if (capabilityId) {
        await createMcpServer(capabilityId, body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "min(560px, 96vw)", maxHeight: "88vh", overflow: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{isEdit ? "Edit" : "New"} MCP server</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", color: "var(--color-outline)", fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-outline)" }}>{isEdit ? "Registered under this capability." : "Registered under the selected capability."} Requires super-admin. * = required.</p>
        <div style={{ display: "grid", gap: 10 }}>
          <IdentityInput label="Name *" value={values.name ?? ""} onChange={set("name")} placeholder="primary-mcp" />
          <IdentityInput label="Base URL *" value={values.base_url ?? ""} onChange={set("base_url")} placeholder="https://mcp.example.com" />
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
            {isEdit ? "Bearer token" : "Bearer token *"}
            <input type="password" value={values.bearer_token ?? ""} onChange={(e) => set("bearer_token")(e.target.value)} placeholder="min 8 characters" style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }} />
            <span style={{ fontWeight: 500, color: "var(--color-outline)", fontSize: 11 }}>{isEdit ? "Leave blank to keep the current token." : "Stored server-side for context-fabric → MCP auth."}</span>
          </label>
          <label style={{ display: "grid", gap: 5, fontSize: 12, fontWeight: 800, color: "var(--color-outline)" }}>
            Protocol
            <select value={values.protocol ?? "MCP_HTTP"} onChange={(e) => set("protocol")(e.target.value)} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", fontSize: 13, color: "var(--color-text)", fontWeight: 500 }}>
              <option value="MCP_HTTP">MCP_HTTP</option>
              <option value="MCP_WS">MCP_WS</option>
            </select>
          </label>
          {isEdit ? <IdentityInput label="Status" value={values.status ?? ""} onChange={set("status")} placeholder="active | suspended" /> : null}
          <IdentityInput label="Protocol version" value={values.protocol_version ?? ""} onChange={set("protocol_version")} placeholder="(optional)" />
          <IdentityInput label="Description" value={values.description ?? ""} onChange={set("description")} placeholder="(optional)" />
          <IdentityInput label="Tags" value={values.tags ?? ""} onChange={set("tags")} placeholder="comma, separated" />
        </div>
        {error ? <div style={{ marginTop: 12 }}><SmallError error={error} /></div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || invalid}>{busy ? "Saving…" : isEdit ? "Save changes" : "Register MCP server"}</button>
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
  const [form, setForm] = useState<AuthzCheckRequest>({ user_id: "", capability_id: "", action: "", tenant_id: "default" });
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
          <IdentityInput label="Tenant ID" value={form.tenant_id} onChange={(value) => setForm({ ...form, tenant_id: value })} placeholder="tenant id" />
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
