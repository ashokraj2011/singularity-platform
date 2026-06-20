"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Archive, ArchiveRestore, Copy, Edit3, FileJson, GitBranch, Play, Plus, RefreshCw, Search, Upload, Workflow, X } from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch, WorkgraphError } from "@/lib/workgraph";

type WorkflowTemplate = {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  profile?: "main" | "workbench" | string | null;
  capabilityId?: string | null;
  workflowTypeKey?: string | null;
  currentVersion?: number | null;
  archivedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type WorkflowInstance = {
  id: string;
  name?: string | null;
  status?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  isDesign?: boolean | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
};

const fetcher = (path: string) => workgraphFetch(path);

export function WorkflowManager({ initialTab = "templates" }: { initialTab?: "templates" | "runs" } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"templates" | "runs">(initialTab);
  const [profile, setProfile] = useState<"main" | "workbench" | "all">("main");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [runTemplate, setRunTemplate] = useState<WorkflowTemplate | null>(null);
  const templatesPath = `/workflow-templates?size=100${showArchived ? "&archived=true" : ""}${profile !== "all" ? `&profile=${profile}` : ""}`;
  const { data: templatesData, error: templatesError, isLoading: templatesLoading, mutate: reloadTemplates } = useSWR(templatesPath, fetcher, { refreshInterval: 15000 });
  const { data: runsData, error: runsError, isLoading: runsLoading, mutate: reloadRuns } = useSWR("/workflow-instances?size=100", fetcher, { refreshInterval: 10000 });
  const templates = unwrapWorkgraphItems<WorkflowTemplate>(templatesData).filter((template) => matches(template, query, ["name", "description", "capabilityId", "workflowTypeKey"]));
  const allRuns = unwrapWorkgraphItems<WorkflowInstance>(runsData).filter((run) => !run.isDesign);
  const requestedTemplateId = searchParams.get("templateId");
  const runs = allRuns
    .filter((run) => !requestedTemplateId || run.templateId === requestedTemplateId)
    .filter((run) => matches(run, query, ["name", "id", "status", "templateId"]));
  const runCountByTemplate = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of allRuns) {
      if (run.templateId) counts[run.templateId] = (counts[run.templateId] ?? 0) + 1;
    }
    return counts;
  }, [allRuns]);
  const activeRuns = allRuns.filter((run) => ["ACTIVE", "PAUSED"].includes(String(run.status ?? "").toUpperCase())).length;
  const requestedRunTemplateId = searchParams.get("run");

  useEffect(() => {
    if (!requestedRunTemplateId || runTemplate) return;
    const requested = templates.find((template) => template.id === requestedRunTemplateId);
    if (requested) setRunTemplate(requested);
  }, [requestedRunTemplateId, runTemplate, templates]);

  useEffect(() => {
    if (requestedTemplateId) setTab("runs");
  }, [requestedTemplateId]);

  async function templateAction(path: string) {
    await workgraphFetch(path, { method: "POST", body: "{}" });
    await reloadTemplates();
  }

  async function duplicateTemplate(template: WorkflowTemplate) {
    const name = window.prompt("Duplicate workflow as", `${template.name} copy`);
    if (!name?.trim()) return;
    await workgraphFetch(`/workflow-templates/${template.id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), asNewVersion: false }),
    });
    await reloadTemplates();
  }

  return (
    <div style={{ maxWidth: 1180 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workflow Manager</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Workflows</h1>
            <p style={{ margin: 0, maxWidth: 780, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.55 }}>
              Create workflow templates, edit design graphs, start runs from WorkItems, and inspect live execution.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/workflows/run" className="btn-secondary"><Play size={15} /> Start Workflow</Link>
            <button className="btn-primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={15} /> New workflow</button>
            <button className="btn-secondary" type="button" onClick={() => { void reloadTemplates(); void reloadRuns(); }}><RefreshCw size={15} /> Refresh</button>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
        <Metric label="Templates" value={templates.length} />
        <Metric label="Runs" value={allRuns.length} />
        <Metric label="Active/paused" value={activeRuns} />
        <Metric label="Profile" value={profile === "all" ? "All" : profile} />
      </section>

      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 6, background: "var(--color-surface-container)", padding: 4, borderRadius: 10 }}>
            <Segment active={tab === "templates"} onClick={() => setTab("templates")}>Workflows</Segment>
            <Segment active={tab === "runs"} onClick={() => setTab("runs")}>Runs</Segment>
          </div>
          {tab === "templates" && (
            <div style={{ display: "flex", gap: 6, background: "var(--color-surface-container)", padding: 4, borderRadius: 10 }}>
              <Segment active={profile === "main"} onClick={() => setProfile("main")}>Main</Segment>
              <Segment active={profile === "workbench"} onClick={() => setProfile("workbench")}>Workbench</Segment>
              <Segment active={profile === "all"} onClick={() => setProfile("all")}>All</Segment>
            </div>
          )}
          {tab === "runs" && requestedTemplateId && (
            <Link href="/runs" className="btn-secondary text-xs">Clear template filter</Link>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 260px", justifyContent: "flex-end" }}>
            <div style={{ position: "relative", minWidth: 220, flex: "0 1 360px" }}>
              <Search size={14} style={{ position: "absolute", left: 11, top: 11, color: "var(--color-outline)" }} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflows or runs" style={inputStyle({ paddingLeft: 33 })} />
            </div>
            {tab === "templates" && (
              <button className="btn-secondary" type="button" onClick={() => setShowArchived((value) => !value)}>
                {showArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                {showArchived ? "Hide archived" : "Show archived"}
              </button>
            )}
          </div>
        </div>
      </section>

      {tab === "templates" ? (
        <section style={{ display: "grid", gap: 10 }}>
          {templatesError && <ErrorPanel error={templatesError} />}
          {templatesLoading && <EmptyPanel text="Loading workflow templates..." />}
          {!templatesLoading && templates.length === 0 && <EmptyPanel text="No workflows match this view." />}
          {templates.map((template) => (
            <article key={template.id} className="card card-hover" style={{ padding: 16, display: "grid", gridTemplateColumns: "42px minmax(0, 1fr) auto", gap: 14, alignItems: "center", opacity: template.archivedAt ? 0.58 : 1 }}>
              <span style={iconBox("#6366f1")}><Workflow size={18} /></span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 850, color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{template.name}</h2>
                  <Badge>{template.status ?? "DRAFT"}</Badge>
                  <Badge>{template.profile ?? "main"}</Badge>
                  {typeof template.currentVersion === "number" && <Badge>v{template.currentVersion}</Badge>}
                </div>
                <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.45 }}>
                  {template.description || "No description"} · {template.workflowTypeKey || "workflow"} · {shortId(template.capabilityId)}
                </p>
              </div>
              <div style={{ display: "flex", gap: 7, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <Link className="btn-secondary text-xs" href={`/workflows/design/${template.id}`}><Edit3 size={13} /> Design</Link>
                <button className="btn-primary text-xs" type="button" disabled={Boolean(template.archivedAt)} onClick={() => setRunTemplate(template)}><Play size={13} /> Run</button>
                <Link className="btn-secondary text-xs" href={`/runs?templateId=${encodeURIComponent(template.id)}`}>{runCountByTemplate[template.id] ?? 0} runs</Link>
                <button className="btn-secondary text-xs" type="button" onClick={() => duplicateTemplate(template)}><Copy size={13} /> Duplicate</button>
                {template.archivedAt ? (
                  <button className="btn-secondary text-xs" type="button" onClick={() => templateAction(`/workflow-templates/${template.id}/restore`)}><ArchiveRestore size={13} /> Restore</button>
                ) : (
                  <button className="btn-secondary text-xs" type="button" onClick={() => templateAction(`/workflow-templates/${template.id}/archive`)}><Archive size={13} /> Archive</button>
                )}
                {template.status === "DRAFT" && !template.archivedAt && (
                  <button className="btn-secondary text-xs" type="button" onClick={() => templateAction(`/workflow-templates/${template.id}/publish`)}><Upload size={13} /> Publish</button>
                )}
                <a className="btn-secondary text-xs" href={`/api/workgraph/workflow-templates/${template.id}/export`}><FileJson size={13} /> Export</a>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section style={{ display: "grid", gap: 10 }}>
          {runsError && <ErrorPanel error={runsError} />}
          {runsLoading && <EmptyPanel text="Loading workflow runs..." />}
          {!runsLoading && runs.length === 0 && <EmptyPanel text="No workflow runs match this view." />}
          {runs.map((run) => (
            <Link key={run.id} href={`/runs/${run.id}`} style={{ textDecoration: "none" }}>
              <article className="card card-hover" style={{ padding: 16, display: "grid", gridTemplateColumns: "42px minmax(0, 1fr) auto", gap: 14, alignItems: "center", opacity: run.archivedAt ? 0.58 : 1 }}>
                <span style={iconBox(statusColor(run.status))}><GitBranch size={18} /></span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <h2 style={{ margin: 0, fontSize: 15, fontWeight: 850, color: "var(--color-on-surface)", overflowWrap: "anywhere" }}>{run.name ?? run.id}</h2>
                    <Badge tone={statusColor(run.status)}>{run.status ?? "UNKNOWN"}</Badge>
                    {typeof run.templateVersion === "number" && <Badge>v{run.templateVersion}</Badge>}
                  </div>
                  <p style={{ margin: "5px 0 0", color: "var(--color-outline)", fontSize: 12 }}>
                    Started {formatDate(run.startedAt ?? run.createdAt)} · Template {shortId(run.templateId)}
                  </p>
                </div>
                <span className="btn-secondary text-xs">Open run</span>
              </article>
            </Link>
          ))}
        </section>
      )}

      {createOpen && <CreateWorkflowDialog onClose={() => setCreateOpen(false)} onCreated={(id) => router.push(`/workflows/design/${id}`)} onReload={() => reloadTemplates()} />}
      {runTemplate && <StartWorkflowDialog workflow={runTemplate} onClose={() => setRunTemplate(null)} />}
    </div>
  );
}

export function StartWorkflowCatalog() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const { data, error, isLoading } = useSWR("/workflow-templates?size=100&profile=main", fetcher, { refreshInterval: 15000 });
  const workflows = unwrapWorkgraphItems<WorkflowTemplate>(data).filter((workflow) => !workflow.archivedAt && matches(workflow, query, ["name", "description", "capabilityId", "workflowTypeKey"]));

  return (
    <div style={{ maxWidth: 1180 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Runtime</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Start Workflow</h1>
            <p style={{ color: "var(--color-outline)", fontSize: 14, margin: 0 }}>Choose a published workflow and attach it to an available WorkItem.</p>
          </div>
          <Link href="/workflows/templates" className="btn-secondary"><Workflow size={15} /> Manage workflows</Link>
        </div>
      </section>
      <div style={{ position: "relative", marginBottom: 16 }}>
        <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--color-outline)" }} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflow catalog" style={inputStyle({ paddingLeft: 34 })} />
      </div>
      {error && <ErrorPanel error={error} />}
      {isLoading && <EmptyPanel text="Loading workflow catalog..." />}
      {!isLoading && workflows.length === 0 && <EmptyPanel text="No runnable workflows found." />}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {workflows.map((workflow) => (
          <article key={workflow.id} className="card card-hover" style={{ padding: 16, minHeight: 178, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <span style={iconBox("var(--color-primary)")}><Workflow size={17} /></span>
              <h2 style={{ fontSize: 15, fontWeight: 850, margin: "12px 0 5px", color: "var(--color-on-surface)" }}>{workflow.name}</h2>
              <p style={{ fontSize: 12, color: "var(--color-outline)", lineHeight: 1.45, margin: 0 }}>{workflow.description || "No description"}</p>
            </div>
            <button className="btn-primary text-xs" type="button" onClick={() => setSelected(workflow)} style={{ alignSelf: "flex-start", marginTop: 14 }}>
              <Play size={13} /> Start from WorkItem
            </button>
          </article>
        ))}
      </section>
      {selected && <StartWorkflowDialog workflow={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CreateWorkflowDialog({ onClose, onCreated, onReload }: { onClose: () => void; onCreated: (id: string) => void; onReload: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [workflowTypeKey, setWorkflowTypeKey] = useState("BUSINESS");
  const [profile, setProfile] = useState<"main" | "workbench">("main");
  const [starter, setStarter] = useState<"EMPTY" | "CAPABILITY_WORKBENCH_BRIDGE">("EMPTY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await workgraphFetch<{ id: string }>("/workflow-templates", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          capabilityId: capabilityId.trim() || undefined,
          workflowTypeKey: workflowTypeKey.trim() || undefined,
          profile,
          starter,
          metadata: { workflowType: workflowTypeKey || "BUSINESS", visibility: "TEAM", criticality: "MEDIUM", dataSensitivity: "INTERNAL" },
        }),
      });
      onReload();
      onCreated(created.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <ModalHeader title="Configure metadata before designing the flow" eyebrow="New workflow" onClose={onClose} />
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Workflow name"><input value={name} onChange={(event) => setName(event.target.value)} style={inputStyle()} autoFocus /></Field>
        <Field label="Purpose"><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} style={inputStyle({ resize: "vertical" })} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <Field label="Workflow type"><input value={workflowTypeKey} onChange={(event) => setWorkflowTypeKey(event.target.value)} style={inputStyle()} /></Field>
          <Field label="Capability id"><input value={capabilityId} onChange={(event) => setCapabilityId(event.target.value)} placeholder="optional, required for agent starter" style={inputStyle()} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          <Field label="Profile">
            <select value={profile} onChange={(event) => setProfile(event.target.value as "main" | "workbench")} style={inputStyle()}>
              <option value="main">Main orchestration</option>
              <option value="workbench">Workbench sub-workflow</option>
            </select>
          </Field>
          <Field label="Starter pattern">
            <select value={starter} onChange={(event) => setStarter(event.target.value as "EMPTY" | "CAPABILITY_WORKBENCH_BRIDGE")} style={inputStyle()}>
              <option value="EMPTY">Empty canvas</option>
              <option value="CAPABILITY_WORKBENCH_BRIDGE">Agent to Workbench to approval</option>
            </select>
          </Field>
        </div>
      </div>
      {error && <p style={{ color: "#991b1b", fontSize: 12 }}>{error}</p>}
      <ModalFooter>
        <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="btn-primary" type="button" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? "Creating..." : "Create and design"}</button>
      </ModalFooter>
    </Modal>
  );
}

function StartWorkflowDialog({ workflow, onClose }: { workflow: WorkflowTemplate; onClose: () => void }) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workItemsPath = workflow.capabilityId ? `/work-items?targetCapabilityId=${encodeURIComponent(workflow.capabilityId)}&available=true&limit=100` : null;
  const { data, isLoading, mutate } = useSWR(workItemsPath, fetcher, { refreshInterval: 10000 });
  const items = unwrapWorkgraphItems<WorkItemRow>(data);
  const choices = items.flatMap((item) => (item.targets ?? [])
    .filter((target) => target.targetCapabilityId === workflow.capabilityId && !target.childWorkflowInstanceId && ["QUEUED", "CLAIMED", "REWORK_REQUESTED"].includes(target.status))
    .map((target) => ({ item, target, key: `${item.id}:${target.id}` })));

  async function createWorkItem() {
    if (!workflow.capabilityId || !createTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await workgraphFetch("/work-items", {
        method: "POST",
        body: JSON.stringify({
          title: createTitle.trim(),
          description: createDescription.trim() || undefined,
          workItemTypeKey: "feature",
          urgency: "NORMAL",
          targets: [{ targetCapabilityId: workflow.capabilityId }],
        }),
      });
      setCreateTitle("");
      setCreateDescription("");
      await mutate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const choice = choices.find((candidate) => candidate.key === selected);
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      if (["QUEUED", "REWORK_REQUESTED"].includes(choice.target.status)) {
        await workgraphFetch(`/work-items/${choice.item.id}/targets/${choice.target.id}/claim`, { method: "POST", body: "{}" });
      }
      const result = await workgraphFetch<{ childWorkflowInstanceId?: string }>(`/work-items/${choice.item.id}/targets/${choice.target.id}/start`, {
        method: "POST",
        body: JSON.stringify({ childWorkflowTemplateId: workflow.id }),
      });
      if (result.childWorkflowInstanceId) router.push(`/runs/${result.childWorkflowInstanceId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <ModalHeader title={workflow.name} eyebrow="Start workflow" onClose={onClose} />
      {!workflow.capabilityId ? (
        <EmptyPanel text="This workflow has no capability owner. Add a capability before starting it from a WorkItem." />
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <section className="card" style={{ padding: 14, boxShadow: "none" }}>
            <Field label="WorkItem input">
              {isLoading ? (
                <div style={{ color: "var(--color-outline)", fontSize: 13 }}>Loading WorkItems...</div>
              ) : choices.length === 0 ? (
                <div style={{ color: "var(--color-outline)", fontSize: 13 }}>
                  No unattached WorkItems are available for this capability. Create one below, then start this workflow.
                </div>
              ) : (
                <select value={selected} onChange={(event) => setSelected(event.target.value)} style={inputStyle()}>
                  <option value="">Select a WorkItem</option>
                  {choices.map(({ item, target, key }) => (
                    <option key={key} value={key}>{item.workCode ?? shortId(item.id)} · {item.title} · {target.status}</option>
                  ))}
                </select>
              )}
            </Field>
            <ModalFooter>
              <button className="btn-primary" type="button" disabled={!selected || busy} onClick={() => void start()}>
                {busy ? "Starting..." : "Start selected WorkItem"}
              </button>
            </ModalFooter>
          </section>

          <section className="card" style={{ padding: 14, boxShadow: "none" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 850 }}>Create WorkItem</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="WorkItem title" style={inputStyle()} />
              <textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="Request details, acceptance criteria, constraints" rows={3} style={inputStyle({ resize: "vertical" })} />
              <button className="btn-secondary" type="button" disabled={!createTitle.trim() || busy} onClick={() => void createWorkItem()}>
                <Plus size={14} /> Create WorkItem for this workflow
              </button>
            </div>
          </section>
        </div>
      )}
      {error && <p style={{ color: "#991b1b", fontSize: 12 }}>{error}</p>}
    </Modal>
  );
}

type WorkItemTarget = { id: string; targetCapabilityId: string; status: string; childWorkflowInstanceId?: string | null };
type WorkItemRow = { id: string; workCode?: string | null; title: string; description?: string | null; targets?: WorkItemTarget[] };

function matches(row: Record<string, unknown>, query: string, keys: string[]): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  return keys.some((key) => String(row[key] ?? "").toLowerCase().includes(q));
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card" style={{ padding: 14, boxShadow: "none" }}>
      <div className="label-xs" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 850, color: "var(--color-on-surface)" }}>{value}</div>
    </div>
  );
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ border: 0, borderRadius: 8, padding: "7px 13px", cursor: "pointer", fontSize: 12, fontWeight: 800, background: active ? "rgba(54,135,39,0.12)" : "transparent", color: active ? "var(--color-primary)" : "var(--color-outline)" }}>
      {children}
    </button>
  );
}

function Badge({ children, tone = "#64748b" }: { children: React.ReactNode; tone?: string }) {
  return <span style={{ fontSize: 10, fontWeight: 850, padding: "3px 7px", borderRadius: 6, color: tone, background: `${tone}14`, border: `1px solid ${tone}28`, textTransform: "uppercase" }}>{children}</span>;
}

function ErrorPanel({ error }: { error: unknown }) {
  const err = error as WorkgraphError;
  return (
    <section className="card" style={{ padding: 16, borderColor: "rgba(185,28,28,0.28)", background: "rgba(254,242,242,0.8)" }}>
      <div style={{ fontWeight: 850, color: "#991b1b" }}>Could not load this workflow surface.</div>
      <div style={{ color: "#7f1d1d", fontSize: 13 }}>{err.status ? `${err.status} ` : ""}{err.code ? `${err.code}: ` : ""}{err.message}</div>
    </section>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return <section className="card" style={{ padding: 24, textAlign: "center", color: "var(--color-outline)" }}>{text}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "grid", gap: 6 }}><span className="label-xs">{label}</span>{children}</label>;
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(15,23,42,0.42)", display: "grid", placeItems: "center", padding: 18 }} onMouseDown={onClose}>
      <section className="card" style={{ width: "min(760px, 100%)", maxHeight: "88vh", overflow: "auto", padding: 18 }} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>
  );
}

function ModalHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 16 }}>
      <div>
        <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 6 }}>{eyebrow}</div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 850, color: "var(--color-on-surface)" }}>{title}</h2>
      </div>
      <button type="button" className="btn-secondary" onClick={onClose} aria-label="Close"><X size={15} /></button>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>{children}</div>;
}

function inputStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    border: "1px solid var(--color-outline-variant)",
    borderRadius: 9,
    padding: "9px 11px",
    background: "#fff",
    color: "var(--color-on-surface)",
    fontSize: 13,
    outline: "none",
    ...extra,
  };
}

function iconBox(color: string): React.CSSProperties {
  return { width: 38, height: 38, borderRadius: 9, display: "grid", placeItems: "center", color, background: `${color}12`, border: `1px solid ${color}24` };
}

function statusColor(status: unknown): string {
  const value = String(status ?? "").toUpperCase();
  if (value === "ACTIVE" || value === "COMPLETED") return "#368727";
  if (value === "PAUSED" || value === "BLOCKED") return "#d97706";
  if (value === "FAILED" || value === "CANCELLED") return "#ba1a1a";
  return "#64748b";
}
