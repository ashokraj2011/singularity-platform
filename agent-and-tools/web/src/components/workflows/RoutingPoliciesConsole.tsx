"use client";

import Link from "next/link";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, CheckCircle2, FileJson, GitBranch, Plus, RefreshCw, Route, Save, Search, X } from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";
import { runtimeApi } from "@/lib/api";

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

const routingModes = ["MANUAL", "AUTO_ATTACH", "AUTO_START", "SCHEDULED_START"];
const commonWorkItemTypes = ["GENERAL", "FEATURE", "BUG", "DOCUMENT_VALIDATION", "SECURITY_REVIEW", "RELEASE"];
const commonWorkflowTypes = ["GENERAL", "SDLC", "STORY_IMPL", "BUG_FIX", "REFACTOR", "QA", "SECURITY_REVIEW", "RELEASE"];

type PolicyForm = {
  capabilityId: string;
  workItemTypeKey: string;
  workflowTypeKey: string;
  workflowId: string;
  routingMode: string;
  priority: string;
  selector: string;
  isActive: boolean;
};

type MetadataKind = "WORK_ITEM_TYPE" | "WORKFLOW_TYPE";

type TypeCreatorForm = {
  kind: MetadataKind;
  key: string;
  label: string;
  description: string;
};

const emptyPolicyForm = (): PolicyForm => ({
  capabilityId: "",
  workItemTypeKey: "GENERAL",
  workflowTypeKey: "GENERAL",
  workflowId: "",
  routingMode: "AUTO_START",
  priority: "100",
  selector: "{}",
  isActive: true,
});

const emptyTypeCreator = (kind: MetadataKind): TypeCreatorForm => ({
  kind,
  key: "",
  label: "",
  description: "",
});

export function RoutingPoliciesConsole() {
  const [filter, setFilter] = useState(filterOptions[0].query);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const path = `/work-item-routing-policies${filter ? `?${filter}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR(path, workgraphFetch, { refreshInterval: 12000 });
  const { data: capabilityData, error: capabilityError } = useSWR("routing-policy-capabilities", () => runtimeApi.listCapabilities(), { refreshInterval: 30000 });
  const { data: workflowData, error: workflowError } = useSWR("routing-policy-workflows", () => workgraphFetch("/workflow-templates?size=200&profile=main"), { refreshInterval: 30000 });
  const { data: metadataData, mutate: mutateMetadata } = useSWR("routing-policy-metadata", () => workgraphFetch("/metadata-definitions?status=ACTIVE"), { refreshInterval: 30000 });
  const policies = unwrapWorkgraphItems<RoutingPolicy>(data).filter((item) => matchesPolicy(item, query));
  const capabilities = rowsFrom(capabilityData).filter((item) => String(item.status ?? "ACTIVE").toUpperCase() === "ACTIVE");
  const workflows = rowsFrom(workflowData).filter((item) => !item.archivedAt && String(item.status ?? "ACTIVE").toUpperCase() !== "ARCHIVED");
  const metadata = rowsFrom(metadataData);
  const selected = useMemo(() => policies.find((item) => item.id === selectedId) ?? policies[0], [policies, selectedId]);
  const issueCount = policies.filter(hasTemplateIssue).length;
  const activeCount = policies.filter((item) => item.isActive !== false).length;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyForm>(emptyPolicyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [typeCreator, setTypeCreator] = useState<TypeCreatorForm | null>(null);
  const [typeCreatorError, setTypeCreatorError] = useState<string | null>(null);
  const [typeCreatorBusy, setTypeCreatorBusy] = useState(false);

  const capabilityOptions = useMemo(() => uniqueRows(capabilities, "id"), [capabilities]);
  const workItemTypeOptions = useMemo(() => uniqueStrings([
    ...commonWorkItemTypes,
    ...policies.map((item) => item.workItemTypeKey ?? ""),
    ...metadata.filter((item) => String(item.kind).toUpperCase() === "WORK_ITEM_TYPE").map((item) => String(item.key ?? "")),
  ]), [metadata, policies]);
  const workflowTypeOptions = useMemo(() => uniqueStrings([
    ...commonWorkflowTypes,
    ...policies.map((item) => item.workflowTypeKey ?? ""),
    ...workflows.map((item) => String(item.workflowTypeKey ?? "")),
    ...metadata.filter((item) => String(item.kind).toUpperCase() === "WORKFLOW_TYPE").map((item) => String(item.key ?? "")),
  ]), [metadata, policies, workflows]);
  const workflowOptions = useMemo(() => workflows
    .filter((item) => !form.capabilityId || !item.capabilityId || item.capabilityId === form.capabilityId)
    .sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? ""))), [form.capabilityId, workflows]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyPolicyForm());
    setFormError(null);
    setTypeCreator(null);
    setTypeCreatorError(null);
    setEditorOpen(true);
  }

  function openEdit(policy: RoutingPolicy) {
    setEditingId(policy.id);
    setSelectedId(policy.id);
    setForm({
      capabilityId: String(policy.capabilityId ?? ""),
      workItemTypeKey: String(policy.workItemTypeKey ?? "GENERAL"),
      workflowTypeKey: String(policy.workflowTypeKey ?? "GENERAL"),
      workflowId: String(policy.workflowId ?? ""),
      routingMode: String(policy.routingMode ?? "MANUAL"),
      priority: String(policy.priority ?? 100),
      selector: JSON.stringify(policy.selector ?? {}, null, 2),
      isActive: policy.isActive !== false,
    });
    setFormError(null);
    setTypeCreator(null);
    setTypeCreatorError(null);
    setEditorOpen(true);
  }

  function openTypeCreator(kind: MetadataKind) {
    setTypeCreator(emptyTypeCreator(kind));
    setTypeCreatorError(null);
  }

  async function createTypeDefinition() {
    if (!typeCreator) return;
    const key = normalizeTypeKey(typeCreator.key);
    const label = typeCreator.label.trim();
    if (!key) {
      setTypeCreatorError("Enter a type key, for example DOCUMENT_REVIEW.");
      return;
    }
    if (!label) {
      setTypeCreatorError("Enter a display label for this type.");
      return;
    }
    setTypeCreatorBusy(true);
    setTypeCreatorError(null);
    try {
      const created = await workgraphFetch<Record<string, unknown>>("/metadata-definitions", {
        method: "POST",
        body: JSON.stringify({
          kind: typeCreator.kind,
          key,
          label,
          description: typeCreator.description.trim() || undefined,
          version: 1,
          status: "ACTIVE",
          scopeType: "GLOBAL",
          scopeId: "*",
          schema: {},
          defaults: {},
          policy: {},
          ui: {},
          compatibility: {},
        }),
      });
      const createdKey = normalizeTypeKey(created.key ?? key);
      setForm((current) => typeCreator.kind === "WORK_ITEM_TYPE"
        ? { ...current, workItemTypeKey: createdKey }
        : { ...current, workflowTypeKey: createdKey });
      setTypeCreator(null);
      await mutateMetadata();
    } catch (err) {
      setTypeCreatorError(err instanceof Error ? err.message : "Could not create metadata type.");
    } finally {
      setTypeCreatorBusy(false);
    }
  }

  async function savePolicy() {
    setFormBusy(true);
    setFormError(null);
    try {
      const selector = JSON.parse(form.selector || "{}") as unknown;
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) throw new Error("Selector must be a JSON object.");
      if (!form.capabilityId) throw new Error("Choose a capability before saving the routing policy.");
      const priority = Number(form.priority);
      if (!Number.isInteger(priority)) throw new Error("Priority must be a whole number.");
      const body = {
        capabilityId: form.capabilityId,
        workItemTypeKey: form.workItemTypeKey.trim() || "GENERAL",
        workflowTypeKey: form.workflowTypeKey.trim() || "GENERAL",
        workflowId: form.workflowId || null,
        routingMode: form.routingMode,
        priority,
        selector,
        isActive: form.isActive,
      };
      await workgraphFetch(`/work-item-routing-policies${editingId ? `/${editingId}` : ""}`, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      setEditorOpen(false);
      setEditingId(null);
      await mutate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save routing policy.");
    } finally {
      setFormBusy(false);
    }
  }

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
            <button className="btn-primary" type="button" onClick={openCreate}><Plus size={15} /> New routing policy</button>
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
      {(capabilityError || workflowError) && <ErrorPanel error={capabilityError ?? workflowError} />}

      {editorOpen && (
        <PolicyEditor
          form={form}
          setForm={setForm}
          editing={Boolean(editingId)}
          busy={formBusy}
          error={formError}
          capabilities={capabilityOptions}
          workflows={workflowOptions}
          workItemTypes={workItemTypeOptions}
          workflowTypes={workflowTypeOptions}
          typeCreator={typeCreator}
          typeCreatorError={typeCreatorError}
          typeCreatorBusy={typeCreatorBusy}
          onOpenTypeCreator={openTypeCreator}
          onTypeCreatorChange={setTypeCreator}
          onCreateType={() => void createTypeDefinition()}
          onCloseTypeCreator={() => { setTypeCreator(null); setTypeCreatorError(null); }}
          onSave={() => void savePolicy()}
          onClose={() => { setEditorOpen(false); setEditingId(null); setFormError(null); setTypeCreator(null); setTypeCreatorError(null); }}
        />
      )}

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
          {selected ? <PolicyDetail policy={selected} onEdit={() => openEdit(selected)} /> : <EmptyPanel text="Select a routing policy to inspect template binding diagnostics." />}
        </section>
      </div>
    </div>
  );
}

function PolicyDetail({ policy, onEdit }: { policy: RoutingPolicy; onEdit: () => void }) {
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
          <button className="btn-secondary text-xs" type="button" onClick={onEdit}><Save size={13} /> Edit policy</button>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--color-outline)", fontWeight: 800 }}>{label}{children}</label>;
}

function PolicyEditor({
  form,
  setForm,
  editing,
  busy,
  error,
  capabilities,
  workflows,
  workItemTypes,
  workflowTypes,
  typeCreator,
  typeCreatorError,
  typeCreatorBusy,
  onOpenTypeCreator,
  onTypeCreatorChange,
  onCreateType,
  onCloseTypeCreator,
  onSave,
  onClose,
}: {
  form: PolicyForm;
  setForm: Dispatch<SetStateAction<PolicyForm>>;
  editing: boolean;
  busy: boolean;
  error: string | null;
  capabilities: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
  workItemTypes: string[];
  workflowTypes: string[];
  typeCreator: TypeCreatorForm | null;
  typeCreatorError: string | null;
  typeCreatorBusy: boolean;
  onOpenTypeCreator: (kind: MetadataKind) => void;
  onTypeCreatorChange: Dispatch<SetStateAction<TypeCreatorForm | null>>;
  onCreateType: () => void;
  onCloseTypeCreator: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const update = (patch: Partial<PolicyForm>) => setForm((current) => ({ ...current, ...patch }));
  const workItemTypeOptions = withCurrentString(workItemTypes, form.workItemTypeKey);
  const workflowTypeOptions = withCurrentString(workflowTypes, form.workflowTypeKey);
  return (
    <section className="card" style={{ padding: 18, marginBottom: 16, borderColor: "rgba(22,101,52,0.28)", background: "rgba(240,253,244,0.38)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div className="label-xs" style={{ color: "var(--color-primary)" }}>{editing ? "Update rule" : "Create rule"}</div>
          <h2 style={{ margin: "5px 0 0", fontSize: 18 }}>{editing ? "Edit routing policy" : "New routing policy"}</h2>
          <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 12 }}>Choose the capability and workflow binding that should receive matching WorkItems.</p>
        </div>
        <button className="btn-secondary text-xs" type="button" onClick={onClose} aria-label="Close policy editor"><X size={14} /> Close</button>
      </div>
      {typeCreator && (
        <TypeCreator
          form={typeCreator}
          error={typeCreatorError}
          busy={typeCreatorBusy}
          onChange={onTypeCreatorChange}
          onSave={onCreateType}
          onClose={onCloseTypeCreator}
        />
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <Field label="Capability">
          <select value={form.capabilityId} onChange={(event) => update({ capabilityId: event.target.value, workflowId: "" })} style={inputStyle()}>
            <option value="">Choose capability</option>
            {capabilities.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? item.label ?? item.id)}</option>)}
            {form.capabilityId && !capabilities.some((item) => String(item.id) === form.capabilityId) && <option value={form.capabilityId}>{shortId(form.capabilityId)} (current)</option>}
          </select>
        </Field>
        <Field label="WorkItem type">
          <div style={{ display: "flex", gap: 6 }}>
            <select value={form.workItemTypeKey} onChange={(event) => update({ workItemTypeKey: event.target.value })} style={inputStyle()}>
              {workItemTypeOptions.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
            </select>
            <button className="btn-secondary text-xs" type="button" onClick={() => onOpenTypeCreator("WORK_ITEM_TYPE")}><Plus size={13} /> New</button>
          </div>
        </Field>
        <Field label="Workflow type">
          <div style={{ display: "flex", gap: 6 }}>
            <select value={form.workflowTypeKey} onChange={(event) => update({ workflowTypeKey: event.target.value })} style={inputStyle()}>
              {workflowTypeOptions.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
            </select>
            <button className="btn-secondary text-xs" type="button" onClick={() => onOpenTypeCreator("WORKFLOW_TYPE")}><Plus size={13} /> New</button>
          </div>
        </Field>
        <Field label="Routing mode">
          <select value={form.routingMode} onChange={(event) => update({ routingMode: event.target.value })} style={inputStyle()}>{routingModes.map((mode) => <option key={mode} value={mode}>{mode.replaceAll("_", " ")}</option>)}</select>
        </Field>
        <Field label="Workflow template">
          <select value={form.workflowId} onChange={(event) => update({ workflowId: event.target.value })} style={inputStyle()}>
            <option value="">No fixed template</option>
            {workflows.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? item.id)} · {String(item.workflowTypeKey ?? "GENERAL")}</option>)}
            {form.workflowId && !workflows.some((item) => String(item.id) === form.workflowId) && <option value={form.workflowId}>{shortId(form.workflowId)} (current)</option>}
          </select>
        </Field>
        <Field label="Priority"><input type="number" value={form.priority} onChange={(event) => update({ priority: event.target.value })} style={inputStyle()} min={0} step={1} /></Field>
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        <Field label="Selector JSON"><textarea value={form.selector} onChange={(event) => update({ selector: event.target.value })} rows={3} style={inputStyle({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, resize: "vertical" })} placeholder='{"eventType":"document.validation.requested"}' /></Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-outline)", fontSize: 12 }}><input type="checkbox" checked={form.isActive} onChange={(event) => update({ isActive: event.target.checked })} /> Active policy</label>
      </div>
      {error && <div className="error-panel" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn-primary" type="button" disabled={busy} onClick={onSave}><Save size={14} /> {busy ? "Saving..." : editing ? "Save policy" : "Create policy"}</button>
      </div>
    </section>
  );
}

function TypeCreator({
  form,
  error,
  busy,
  onChange,
  onSave,
  onClose,
}: {
  form: TypeCreatorForm;
  error: string | null;
  busy: boolean;
  onChange: Dispatch<SetStateAction<TypeCreatorForm | null>>;
  onSave: () => void;
  onClose: () => void;
}) {
  const update = (patch: Partial<TypeCreatorForm>) => onChange((current) => current ? { ...current, ...patch } : current);
  const label = form.kind === "WORK_ITEM_TYPE" ? "WorkItem type" : "Workflow type";
  return (
    <div style={{ borderTop: "1px solid var(--color-outline-variant)", borderBottom: "1px solid var(--color-outline-variant)", padding: "14px 0", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div className="label-xs" style={{ color: "var(--color-primary)" }}>Metadata catalog</div>
          <strong style={{ display: "block", marginTop: 4, fontSize: 14 }}>Create {label}</strong>
          <span style={{ display: "block", marginTop: 3, color: "var(--color-outline)", fontSize: 12 }}>The new key will be active globally and selected in this policy.</span>
        </div>
        <button className="btn-secondary text-xs" type="button" onClick={onClose} aria-label={`Close create ${label} form`}><X size={13} /> Cancel</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 0.8fr) minmax(180px, 0.8fr) minmax(220px, 1.4fr) auto", gap: 8, alignItems: "end" }}>
        <Field label="Key">
          <input value={form.key} onChange={(event) => update({ key: event.target.value })} style={inputStyle({ textTransform: "uppercase" })} placeholder="DOCUMENT_REVIEW" autoFocus />
        </Field>
        <Field label="Display label">
          <input value={form.label} onChange={(event) => update({ label: event.target.value })} style={inputStyle()} placeholder={label} />
        </Field>
        <Field label="Description (optional)">
          <input value={form.description} onChange={(event) => update({ description: event.target.value })} style={inputStyle()} placeholder="Used for document review work" />
        </Field>
        <button className="btn-primary text-xs" type="button" disabled={busy} onClick={onSave}><Save size={13} /> {busy ? "Creating..." : "Create type"}</button>
      </div>
      {error && <div className="error-panel" role="alert" style={{ marginTop: 9 }}>{error}</div>}
      <div style={{ marginTop: 8, color: "var(--color-outline)", fontSize: 11 }}>Manage existing definitions in <Link href="/workflows/metadata" className="underline">Workflow Metadata</Link>.</div>
    </div>
  );
}

function normalizeTypeKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function withCurrentString(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [current, ...values] : values;
}

function rowsFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  for (const key of ["items", "content", "data", "templates", "capabilities", "tools", "policies", "grants"]) {
    if (Array.isArray(row[key])) return rowsFrom(row[key]);
  }
  return [];
}

function uniqueRows(rows: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const value = String(row[key] ?? "");
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
}
