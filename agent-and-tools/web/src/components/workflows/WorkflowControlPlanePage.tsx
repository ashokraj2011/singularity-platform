"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileJson,
  FlaskConical,
  GitBranch,
  Globe,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  ShieldCheck,
  Terminal,
  Trash2,
  Webhook,
  Workflow,
  XCircle,
} from "lucide-react";
import { formatDate, shortId, unwrapWorkgraphItems, valueText, workgraphFetch } from "@/lib/workgraph";

type LlmConnection = {
  id?: string;
  alias: string;
  label?: string;
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string | null;
  credentialEnv?: string | null;
  credentialPresent?: boolean;
  credentialStatus?: string;
  costTier?: string | null;
  default?: boolean;
};

type TouchPoint = { key: string; label: string; description?: string };
type LlmRule = { id: string; touchPoint: string; scopeType: string; scopeId: string; modelAlias: string; enabled?: boolean };

type WorkItemTrigger = {
  id: string;
  triggerType?: "EVENT" | "WEBHOOK" | "SCHEDULE" | string;
  eventTypeKey?: string | null;
  capabilityId?: string | null;
  workItemTypeKey?: string | null;
  routingMode?: string | null;
  scheduleConfig?: Record<string, unknown> | null;
  payloadMapping?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  isActive?: boolean | null;
  lastFiredAt?: string | null;
  createdAt?: string | null;
};

type RoutingPolicy = {
  id: string;
  capabilityId?: string | null;
  workItemTypeKey?: string | null;
  workflowTypeKey?: string | null;
  workflowId?: string | null;
  routingMode?: string | null;
  isActive?: boolean | null;
  workflowTemplateStatus?: { state?: string | null; reason?: string | null; message?: string | null } | null;
};

type EventSubscription = {
  id: string;
  subscriberId?: string | null;
  eventPattern?: string | null;
  targetUrl?: string | null;
  isActive?: boolean | null;
  createdAt?: string | null;
  metadata?: unknown;
};

type PendingExecution = {
  id: string;
  instanceId?: string;
  nodeId?: string;
  location?: string;
  attempt?: number;
  claimedAt?: string | null;
  claimedBy?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
  node?: { nodeType?: string; label?: string; config?: Record<string, unknown> | null } | null;
  instance?: { name?: string; status?: string } | null;
};

type JsonResult = { kind: "idle" } | { kind: "ok"; value: unknown } | { kind: "error"; message: string };

const jsonDefaults = {
  triggerMapping: JSON.stringify({
    title: "description",
    description: "description",
    workCodePath: "workid",
    correlationKeyPath: "workid",
    documentsPath: "documents",
  }, null, 2),
  eventPayload: JSON.stringify({
    workid: "WRK-DEMO-001",
    capabilityName: "Payments",
    description: "Validate the attached design document and approve or send back with findings.",
    documents: [
      { label: "Design document", url: "https://example.com/design.md" },
    ],
  }, null, 2),
  directLlmFields: JSON.stringify({
    verdict: { type: "string", enum: ["APPROVE", "REJECT", "SEND_BACK"], description: "final decision" },
    confidence: { type: "number" },
    findings: { type: "array", items: { type: "string" } },
  }, null, 2),
};

function endpoint(path: string) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:5180";
  return `${origin}/api/workgraph${path}`;
}

function newSecret() {
  const bytes = new Uint8Array(18);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return workgraphFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
}

async function deletePath(path: string): Promise<void> {
  await workgraphFetch(path, { method: "DELETE" });
}

export function WorkflowControlPlanePage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<JsonResult>({ kind: "idle" });
  const [connectionForm, setConnectionForm] = useState({
    name: "",
    provider: "anthropic",
    model: "",
    alias: "",
    baseUrl: "",
    credentialEnv: "ANTHROPIC_API_KEY",
  });
  const [ruleForm, setRuleForm] = useState({ touchPoint: "GOVERNED_AGENT", scopeType: "DEFAULT", scopeId: "", modelAlias: "" });
  const [triggerForm, setTriggerForm] = useState({
    triggerType: "EVENT",
    eventTypeKey: "document.validation.requested",
    capabilityId: "",
    workItemTypeKey: "DOCUMENT_VALIDATION",
    routingMode: "AUTO_START",
    dedupeKey: "",
    secret: newSecret(),
    payloadMapping: jsonDefaults.triggerMapping,
  });
  const [subscriptionForm, setSubscriptionForm] = useState({
    subscriberId: "sdlc-status-listener",
    eventPattern: "workitem.*",
    targetUrl: "",
    secret: "",
  });
  const [eventForm, setEventForm] = useState({
    eventType: "document.validation.requested",
    capabilityId: "",
    deliveryId: "demo-delivery-001",
    payload: jsonDefaults.eventPayload,
  });
  const [pendingLocation, setPendingLocation] = useState("CLIENT");
  const [directLlmForm, setDirectLlmForm] = useState({
    alias: "",
    promptUrl: "https://example.com/verifier-prompt.md",
    outputFields: jsonDefaults.directLlmFields,
  });

  const connectionsQ = useSWR("/llm-routing/connections", workgraphFetch, { refreshInterval: 15000 });
  const touchPointsQ = useSWR("/llm-routing/touch-points", workgraphFetch, { refreshInterval: 30000 });
  const rulesQ = useSWR("/llm-routing/rules", workgraphFetch, { refreshInterval: 15000 });
  const triggersQ = useSWR("/work-item-triggers", workgraphFetch, { refreshInterval: 15000 });
  const policiesQ = useSWR("/work-item-routing-policies?isActive=true", workgraphFetch, { refreshInterval: 15000 });
  const subscriptionsQ = useSWR("/events/subscriptions?is_active=true", workgraphFetch, { refreshInterval: 15000 });
  const pendingQ = useSWR(`/workflow-instances/pending-executions/poll?location=${pendingLocation}`, workgraphFetch, { refreshInterval: 8000 });

  const connections = unwrapWorkgraphItems<LlmConnection>(connectionsQ.data);
  const touchPoints = unwrapWorkgraphItems<TouchPoint>(touchPointsQ.data);
  const rules = unwrapWorkgraphItems<LlmRule>(rulesQ.data);
  const triggers = unwrapWorkgraphItems<WorkItemTrigger>(triggersQ.data);
  const policies = unwrapWorkgraphItems<RoutingPolicy>(policiesQ.data);
  const subscriptions = unwrapWorkgraphItems<EventSubscription>(subscriptionsQ.data);
  const pendingExecutions = unwrapWorkgraphItems<PendingExecution>(pendingQ.data);

  const missingCredentials = connections.filter((item) => item.credentialStatus && !["configured", "not-required"].includes(item.credentialStatus)).length;
  const activeAutoStartTriggers = triggers.filter((item) => item.isActive !== false && item.routingMode === "AUTO_START").length;
  const activeSubscriptions = subscriptions.filter((item) => item.isActive !== false).length;
  const defaultRules = rules.filter((item) => item.enabled !== false && item.scopeType === "DEFAULT").length;

  const mutateAll = () => {
    void connectionsQ.mutate();
    void touchPointsQ.mutate();
    void rulesQ.mutate();
    void triggersQ.mutate();
    void policiesQ.mutate();
    void subscriptionsQ.mutate();
    void pendingQ.mutate();
  };

  async function runAction(name: string, action: () => Promise<unknown>) {
    setBusy(name);
    setResult({ kind: "idle" });
    try {
      const value = await action();
      setResult({ kind: "ok", value });
      mutateAll();
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const directLlmConfig = useMemo(() => ({
    llmRoute: "workgraph",
    modelAlias: directLlmForm.alias || connections[0]?.alias || "mock",
    promptUrl: directLlmForm.promptUrl,
    coWork: true,
    reviewRequired: true,
    outputFields: safeJson(directLlmForm.outputFields),
  }), [connections, directLlmForm]);

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 1500 }}>
      <section className="card" style={{ padding: 24, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workflow module</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>Workflow Control Plane</h1>
            <p style={{ margin: 0, color: "var(--color-outline)", maxWidth: 920, lineHeight: 1.6, fontSize: 14 }}>
              Configure WorkGraph-owned LLM aliases, event intake, webhook triggers, event-bus subscribers, pending execution runners, and direct-LLM harness presets from one operational screen.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-secondary" href="/workflows/templates"><Workflow size={15} /> Workflow manager</Link>
            <Link className="btn-secondary" href="/workflows/routing-policies"><Route size={15} /> Routing</Link>
            <button className="btn-secondary" type="button" onClick={mutateAll}><RefreshCw size={15} /> Refresh</button>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <Metric label="LLM connections" value={connections.length} tone={missingCredentials ? "#b45309" : "#15803d"} detail={missingCredentials ? `${missingCredentials} need env vars` : "ready or mock"} icon={<Cpu size={17} />} />
        <Metric label="Routing rules" value={rules.length} tone="#2563eb" detail={`${defaultRules} default mappings`} icon={<Route size={17} />} />
        <Metric label="Active triggers" value={triggers.filter((item) => item.isActive !== false).length} tone="#7c3aed" detail={`${activeAutoStartTriggers} auto-start`} icon={<Webhook size={17} />} />
        <Metric label="Event subscribers" value={activeSubscriptions} tone="#0d9488" detail="outbound event bus" icon={<RadioTower size={17} />} />
        <Metric label="Pending executions" value={pendingExecutions.length} tone={pendingExecutions.length ? "#d97706" : "#15803d"} detail={`${pendingLocation.toLowerCase()} queue`} icon={<Activity size={17} />} />
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 0.95fr) minmax(460px, 1.05fr)", gap: 16, alignItems: "start" }}>
        <section style={{ display: "grid", gap: 16 }}>
          <Panel title="LLM providers" eyebrow="Direct calls" icon={<Cpu size={17} />} action={<Link href="/llm-settings" className="btn-secondary text-xs">Runtime switchboard</Link>}>
            <p style={mutedText}>
              Direct LLM nodes read provider credentials from the WorkGraph API process environment. Store only the env var name here.
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {connections.length === 0 && <Empty text="No LLM connections returned. Add one below or check /api/llm-routing/connections." />}
              {connections.slice(0, 6).map((item) => (
                <div key={item.id ?? item.alias} style={rowCard}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{item.label ?? item.name ?? item.alias}</strong>
                      <Badge tone={credentialOk(item) ? "#15803d" : "#b45309"}>{item.credentialStatus ?? "unknown"}</Badge>
                    </div>
                    <p style={smallMuted}>{item.provider ?? "provider"} · {item.model ?? "model"} · env {item.credentialEnv ?? "not set"}</p>
                  </div>
                  {item.id && (
                    <button type="button" className="btn-secondary text-xs" disabled={busy === `delete-conn-${item.id}`} onClick={() => void runAction(`delete-conn-${item.id}`, () => deletePath(`/llm-routing/connections/${item.id}`))}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <FormGrid>
              <Field label="Name"><input style={inputStyle} value={connectionForm.name} onChange={(e) => setConnectionForm({ ...connectionForm, name: e.target.value })} placeholder="Claude Sonnet production" /></Field>
              <Field label="Provider"><select style={inputStyle} value={connectionForm.provider} onChange={(e) => setConnectionForm({ ...connectionForm, provider: e.target.value, credentialEnv: suggestedEnv(e.target.value) })}>{["anthropic", "openai", "copilot", "openrouter", "mock", "custom"].map((p) => <option key={p}>{p}</option>)}</select></Field>
              <Field label="Model"><input style={inputStyle} value={connectionForm.model} onChange={(e) => setConnectionForm({ ...connectionForm, model: e.target.value })} placeholder="claude-sonnet-4-5" /></Field>
              <Field label="Alias"><input style={inputStyle} value={connectionForm.alias} onChange={(e) => setConnectionForm({ ...connectionForm, alias: e.target.value })} placeholder="sonnet-prod" /></Field>
              <Field label="Base URL"><input style={inputStyle} value={connectionForm.baseUrl} onChange={(e) => setConnectionForm({ ...connectionForm, baseUrl: e.target.value })} placeholder="optional OpenAI-compatible URL" /></Field>
              <Field label="Credential env"><input style={inputStyle} value={connectionForm.credentialEnv} onChange={(e) => setConnectionForm({ ...connectionForm, credentialEnv: e.target.value })} placeholder="ANTHROPIC_API_KEY" /></Field>
            </FormGrid>
            <button className="btn-primary" type="button" disabled={busy === "create-connection"} onClick={() => void runAction("create-connection", () => postJson("/llm-routing/connections", {
              name: connectionForm.name || connectionForm.alias,
              provider: connectionForm.provider,
              model: connectionForm.model,
              alias: connectionForm.alias,
              ...(connectionForm.baseUrl.trim() ? { baseUrl: connectionForm.baseUrl.trim() } : {}),
              ...(connectionForm.credentialEnv.trim() ? { credentialEnv: connectionForm.credentialEnv.trim() } : {}),
              enabled: true,
            }))}>
              <Plus size={15} /> Add LLM connection
            </button>
          </Panel>

          <Panel title="Event intake and webhooks" eyebrow="Inbound" icon={<Webhook size={17} />}>
            <p style={mutedText}>
              Inbound events create or attach WorkItems, then route or auto-start workflows through active routing policies.
            </p>
            <FormGrid>
              <Field label="Trigger type"><select style={inputStyle} value={triggerForm.triggerType} onChange={(e) => setTriggerForm({ ...triggerForm, triggerType: e.target.value })}>{["EVENT", "WEBHOOK", "SCHEDULE"].map((v) => <option key={v}>{v}</option>)}</select></Field>
              <Field label="Event type"><input style={inputStyle} value={triggerForm.eventTypeKey} onChange={(e) => setTriggerForm({ ...triggerForm, eventTypeKey: e.target.value })} placeholder="document.validation.requested" /></Field>
              <Field label="Capability id"><input style={inputStyle} value={triggerForm.capabilityId} onChange={(e) => setTriggerForm({ ...triggerForm, capabilityId: e.target.value })} placeholder="required for auto-start" /></Field>
              <Field label="WorkItem type"><input style={inputStyle} value={triggerForm.workItemTypeKey} onChange={(e) => setTriggerForm({ ...triggerForm, workItemTypeKey: e.target.value })} /></Field>
              <Field label="Routing mode"><select style={inputStyle} value={triggerForm.routingMode} onChange={(e) => setTriggerForm({ ...triggerForm, routingMode: e.target.value })}>{["MANUAL", "AUTO_ATTACH", "AUTO_START", "SCHEDULED_START"].map((v) => <option key={v}>{v}</option>)}</select></Field>
              <Field label="Dedupe key"><input style={inputStyle} value={triggerForm.dedupeKey} onChange={(e) => setTriggerForm({ ...triggerForm, dedupeKey: e.target.value })} placeholder="optional static key" /></Field>
              {triggerForm.triggerType === "WEBHOOK" && <Field label="Webhook secret"><input style={inputStyle} value={triggerForm.secret} onChange={(e) => setTriggerForm({ ...triggerForm, secret: e.target.value })} /></Field>}
            </FormGrid>
            <Field label="Payload mapping JSON">
              <textarea style={textareaStyle} rows={7} value={triggerForm.payloadMapping} onChange={(e) => setTriggerForm({ ...triggerForm, payloadMapping: e.target.value })} />
            </Field>
            {triggerForm.triggerType === "WEBHOOK" && (
              <CommandBlock title="Webhook URL" text={endpoint(`/triggers/webhook/${triggerForm.secret || "<secret>"}`)} />
            )}
            <button className="btn-primary" type="button" disabled={busy === "create-trigger"} onClick={() => void runAction("create-trigger", () => {
              const mapping = parseJsonObject(triggerForm.payloadMapping, "Payload mapping");
              return postJson("/work-item-triggers", {
                triggerType: triggerForm.triggerType,
                ...(triggerForm.eventTypeKey.trim() ? { eventTypeKey: triggerForm.eventTypeKey.trim() } : {}),
                ...(triggerForm.capabilityId.trim() ? { capabilityId: triggerForm.capabilityId.trim() } : {}),
                workItemTypeKey: triggerForm.workItemTypeKey || "GENERAL",
                routingMode: triggerForm.routingMode,
                payloadMapping: triggerForm.triggerType === "WEBHOOK" ? { ...mapping, secret: triggerForm.secret } : mapping,
                scheduleConfig: triggerForm.triggerType === "WEBHOOK" ? { secret: triggerForm.secret } : {},
                ...(triggerForm.dedupeKey.trim() ? { dedupeKey: triggerForm.dedupeKey.trim() } : {}),
                isActive: true,
              });
            })}>
              <Plus size={15} /> Create trigger
            </button>
          </Panel>
        </section>

        <section style={{ display: "grid", gap: 16 }}>
          <Panel title="LLM routing by touch point" eyebrow="Model policy" icon={<Route size={17} />}>
            <p style={mutedText}>
              Map a WorkGraph touch point to an alias. USER and CAPABILITY scope can be managed from the dedicated routing canvas later; this creates the default operational mapping.
            </p>
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              {touchPoints.map((tp) => {
                const rule = rules.find((r) => r.touchPoint === tp.key && r.scopeType === "DEFAULT" && r.enabled !== false);
                return (
                  <div key={tp.key} style={rowCard}>
                    <div>
                      <strong>{tp.label}</strong>
                      <p style={smallMuted}>{tp.description ?? tp.key}</p>
                    </div>
                    <Badge tone={rule ? "#15803d" : "#64748b"}>{rule?.modelAlias ?? "inherits"}</Badge>
                  </div>
                );
              })}
            </div>
            <FormGrid>
              <Field label="Touch point"><select style={inputStyle} value={ruleForm.touchPoint} onChange={(e) => setRuleForm({ ...ruleForm, touchPoint: e.target.value })}>{touchPoints.map((tp) => <option key={tp.key} value={tp.key}>{tp.label}</option>)}</select></Field>
              <Field label="Alias"><select style={inputStyle} value={ruleForm.modelAlias} onChange={(e) => setRuleForm({ ...ruleForm, modelAlias: e.target.value })}><option value="">Choose alias</option>{connections.map((conn) => <option key={conn.alias} value={conn.alias}>{conn.label ?? conn.alias}</option>)}</select></Field>
              <Field label="Scope"><select style={inputStyle} value={ruleForm.scopeType} onChange={(e) => setRuleForm({ ...ruleForm, scopeType: e.target.value })}>{["DEFAULT", "CAPABILITY", "USER"].map((v) => <option key={v}>{v}</option>)}</select></Field>
              <Field label="Scope id"><input style={inputStyle} value={ruleForm.scopeId} onChange={(e) => setRuleForm({ ...ruleForm, scopeId: e.target.value })} placeholder="blank for DEFAULT" /></Field>
            </FormGrid>
            <button className="btn-primary" type="button" disabled={busy === "create-rule" || !ruleForm.modelAlias} onClick={() => void runAction("create-rule", () => postJson("/llm-routing/rules", {
              touchPoint: ruleForm.touchPoint,
              scopeType: ruleForm.scopeType,
              scopeId: ruleForm.scopeType === "DEFAULT" ? "" : ruleForm.scopeId,
              modelAlias: ruleForm.modelAlias,
              enabled: true,
            }))}>
              <ShieldCheck size={15} /> Save routing rule
            </button>
          </Panel>

          <Panel title="Event bus subscriptions" eyebrow="Outbound" icon={<RadioTower size={17} />}>
            <p style={mutedText}>
              Subscribe an external system to platform events. The dispatcher posts matching outbox events to the target URL with optional HMAC signing.
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {subscriptions.slice(0, 5).map((sub) => (
                <div key={sub.id} style={rowCard}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{sub.subscriberId ?? shortId(sub.id)}</strong>
                    <p style={smallMuted}>{sub.eventPattern} to {sub.targetUrl}</p>
                  </div>
                  <Badge tone={sub.isActive === false ? "#64748b" : "#15803d"}>{sub.isActive === false ? "inactive" : "active"}</Badge>
                </div>
              ))}
              {subscriptions.length === 0 && <Empty text="No active event-bus subscribers." />}
            </div>
            <FormGrid>
              <Field label="Subscriber id"><input style={inputStyle} value={subscriptionForm.subscriberId} onChange={(e) => setSubscriptionForm({ ...subscriptionForm, subscriberId: e.target.value })} /></Field>
              <Field label="Event pattern"><input style={inputStyle} value={subscriptionForm.eventPattern} onChange={(e) => setSubscriptionForm({ ...subscriptionForm, eventPattern: e.target.value })} placeholder="workitem.*" /></Field>
              <Field label="Target URL"><input style={inputStyle} value={subscriptionForm.targetUrl} onChange={(e) => setSubscriptionForm({ ...subscriptionForm, targetUrl: e.target.value })} placeholder="https://example.com/events" /></Field>
              <Field label="HMAC secret"><input style={inputStyle} value={subscriptionForm.secret} onChange={(e) => setSubscriptionForm({ ...subscriptionForm, secret: e.target.value })} placeholder="optional" /></Field>
            </FormGrid>
            <button className="btn-primary" type="button" disabled={busy === "create-subscription"} onClick={() => void runAction("create-subscription", () => postJson("/events/subscriptions", {
              subscriberId: subscriptionForm.subscriberId,
              eventPattern: subscriptionForm.eventPattern,
              targetUrl: subscriptionForm.targetUrl,
              ...(subscriptionForm.secret.trim() ? { secret: subscriptionForm.secret.trim() } : {}),
              metadata: { source: "workflow-control-plane" },
            }))}>
              <Plus size={15} /> Add subscriber
            </button>
          </Panel>

          <Panel title="Pending execution monitor" eyebrow="Client / Edge / External" icon={<Activity size={17} />}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {["CLIENT", "EDGE", "EXTERNAL"].map((location) => <Segment key={location} active={pendingLocation === location} onClick={() => setPendingLocation(location)}>{location}</Segment>)}
            </div>
            <p style={mutedText}>
              Non-server execution locations queue PendingExecution rows. A deployed runner must poll, claim, execute, and complete them.
            </p>
            <CommandBlock title="Runner poll" text={`curl -s -H "Authorization: Bearer $TOKEN" "${endpoint(`/workflow-instances/pending-executions/poll?location=${pendingLocation}`)}"`} />
            <div style={{ display: "grid", gap: 8 }}>
              {pendingExecutions.map((item) => (
                <div key={item.id} style={rowCard}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{item.node?.label ?? shortId(item.nodeId)}</strong>
                    <p style={smallMuted}>{item.location} · {item.instance?.name ?? shortId(item.instanceId)} · expires {formatDate(item.expiresAt)}</p>
                  </div>
                  <Badge tone={item.claimedAt ? "#2563eb" : "#d97706"}>{item.claimedAt ? "claimed" : "waiting"}</Badge>
                </div>
              ))}
              {pendingExecutions.length === 0 && <Empty text={`No ${pendingLocation.toLowerCase()} pending executions.`} />}
            </div>
          </Panel>
        </section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) minmax(360px, 1fr)", gap: 16 }}>
        <Panel title="Event simulator" eyebrow="Test intake" icon={<FlaskConical size={17} />}>
          <p style={mutedText}>Post a sample event into WorkGraph. Matching EVENT triggers create/attach WorkItems and route them.</p>
          <FormGrid>
            <Field label="Event type"><input style={inputStyle} value={eventForm.eventType} onChange={(e) => setEventForm({ ...eventForm, eventType: e.target.value })} /></Field>
            <Field label="Capability id"><input style={inputStyle} value={eventForm.capabilityId} onChange={(e) => setEventForm({ ...eventForm, capabilityId: e.target.value })} placeholder="optional narrowing" /></Field>
            <Field label="Delivery id"><input style={inputStyle} value={eventForm.deliveryId} onChange={(e) => setEventForm({ ...eventForm, deliveryId: e.target.value })} /></Field>
          </FormGrid>
          <Field label="Payload JSON"><textarea style={textareaStyle} rows={9} value={eventForm.payload} onChange={(e) => setEventForm({ ...eventForm, payload: e.target.value })} /></Field>
          <button className="btn-primary" type="button" disabled={busy === "simulate-event"} onClick={() => void runAction("simulate-event", () => {
            const payload = parseJsonObject(eventForm.payload, "Event payload");
            return postJson("/events/ingest", {
              eventType: eventForm.eventType,
              ...(eventForm.capabilityId.trim() ? { capabilityId: eventForm.capabilityId.trim() } : {}),
              ...(eventForm.deliveryId.trim() ? { deliveryId: eventForm.deliveryId.trim() } : {}),
              payload,
            });
          })}>
            <Play size={15} /> Simulate event
          </button>
        </Panel>

        <Panel title="Direct LLM harness preset" eyebrow="Agent task" icon={<Terminal size={17} />}>
          <p style={mutedText}>
            Use this config on a Direct LLM Task or Agent Task with WorkGraph LLM route. Prompt can come from URL/profile skills; structured fields become workflow data for decision gates.
          </p>
          <FormGrid>
            <Field label="Model alias"><select style={inputStyle} value={directLlmForm.alias} onChange={(e) => setDirectLlmForm({ ...directLlmForm, alias: e.target.value })}><option value="">Use first/default connection</option>{connections.map((conn) => <option key={conn.alias} value={conn.alias}>{conn.label ?? conn.alias}</option>)}</select></Field>
            <Field label="Prompt URL"><input style={inputStyle} value={directLlmForm.promptUrl} onChange={(e) => setDirectLlmForm({ ...directLlmForm, promptUrl: e.target.value })} /></Field>
          </FormGrid>
          <Field label="Output field schema"><textarea style={textareaStyle} rows={8} value={directLlmForm.outputFields} onChange={(e) => setDirectLlmForm({ ...directLlmForm, outputFields: e.target.value })} /></Field>
          <CommandBlock title="Node config JSON" text={JSON.stringify(directLlmConfig, null, 2)} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn-secondary" href="/workflows/node-types"><FileJson size={15} /> Node types</Link>
            <Link className="btn-secondary" href="/workflows/templates"><GitBranch size={15} /> Open workflow manager</Link>
          </div>
        </Panel>
      </div>

      <Panel title="Current workflow automation map" eyebrow="Readiness" icon={<Globe size={17} />}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          <Readiness label="LLM alias configured" ok={connections.length > 0} detail={connections.length ? `${connections.length} aliases available` : "Add an LLM connection or model catalog"} />
          <Readiness label="Default LLM route" ok={defaultRules > 0} detail={defaultRules ? `${defaultRules} default touch points mapped` : "Map at least Governed Agent or Copilot SDLC"} />
          <Readiness label="Event intake trigger" ok={triggers.some((item) => item.triggerType === "EVENT" && item.isActive !== false)} detail="EVENT trigger can create/attach WorkItems" />
          <Readiness label="Webhook intake trigger" ok={triggers.some((item) => item.triggerType === "WEBHOOK" && item.isActive !== false)} detail="WEBHOOK trigger has a secret-gated URL" />
          <Readiness label="Auto-start route" ok={policies.some((item) => item.routingMode === "AUTO_START" && item.isActive !== false)} detail="Routing policy can start workflow from WorkItem" />
          <Readiness label="Outbound event bus" ok={activeSubscriptions > 0} detail="Subscribers receive emitted events" />
          <Readiness label="Runner queues clear" ok={pendingExecutions.length === 0} detail={pendingExecutions.length ? `${pendingExecutions.length} ${pendingLocation} execution(s) waiting` : "No selected queue backlog"} />
        </div>
      </Panel>

      <ResultPanel result={result} onClear={() => setResult({ kind: "idle" })} />
    </div>
  );
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { _invalidJson: true, raw: text }; }
}

function suggestedEnv(provider: string) {
  const p = provider.toLowerCase();
  if (p === "anthropic") return "ANTHROPIC_API_KEY";
  if (p === "openai") return "OPENAI_API_KEY";
  if (p === "copilot") return "COPILOT_PROVIDER_API_KEY";
  if (p === "openrouter") return "OPENROUTER_API_KEY";
  return "";
}

function credentialOk(item: LlmConnection) {
  return item.credentialStatus === "configured" || item.credentialStatus === "not-required" || item.credentialPresent === true;
}

function Panel({ title, eyebrow, icon, children, action }: { title: string; eyebrow?: string; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          {icon && <div style={iconWell}>{icon}</div>}
          <div>
            {eyebrow && <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 5 }}>{eyebrow}</div>}
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 900, letterSpacing: 0 }}>{title}</h2>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, detail, tone, icon }: { label: string; value: unknown; detail?: string; tone: string; icon?: ReactNode }) {
  return (
    <div className="card" style={{ padding: 15, boxShadow: "none", borderColor: `${tone}24`, background: `linear-gradient(135deg, ${tone}0f, #fff 62%)` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</div>
        {icon && <span style={{ color: tone }}>{icon}</span>}
      </div>
      <div style={{ marginTop: 7, fontSize: 22, fontWeight: 950, color: tone }}>{valueText(value)}</div>
      {detail && <div style={{ marginTop: 3, color: "var(--color-outline)", fontSize: 12, fontWeight: 700 }}>{detail}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: "grid", gap: 5 }}><span className="label-xs" style={{ color: "var(--color-outline)" }}>{label}</span>{children}</label>;
}

function FormGrid({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>{children}</div>;
}

function Badge({ children, tone = "#64748b" }: { children: ReactNode; tone?: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", border: `1px solid ${tone}33`, color: tone, background: `${tone}12`, borderRadius: 999, padding: "3px 8px", fontSize: 10.5, fontWeight: 850, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>;
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} style={{ border: 0, background: active ? "#fff" : "var(--color-surface-container)", color: active ? "var(--color-primary)" : "var(--color-outline)", borderRadius: 8, padding: "7px 10px", fontWeight: 850, fontSize: 12, cursor: "pointer", boxShadow: active ? "0 1px 2px rgba(15,23,42,0.08)" : "none" }}>{children}</button>;
}

function Empty({ text }: { text: string }) {
  return <div style={{ border: "1px dashed var(--color-outline-variant)", borderRadius: 8, padding: 13, color: "var(--color-outline)", fontSize: 13 }}>{text}</div>;
}

function Readiness({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 13, borderRadius: 10, border: `1px solid ${ok ? "rgba(22,101,52,0.22)" : "rgba(180,83,9,0.24)"}`, background: ok ? "rgba(240,253,244,0.72)" : "rgba(255,251,235,0.78)" }}>
      {ok ? <CheckCircle2 size={17} color="#15803d" /> : <AlertTriangle size={17} color="#b45309" />}
      <div>
        <div style={{ fontWeight: 900, color: ok ? "#166534" : "#92400e" }}>{label}</div>
        <div style={{ marginTop: 3, fontSize: 12, color: ok ? "#166534" : "#92400e", lineHeight: 1.45 }}>{detail}</div>
      </div>
    </div>
  );
}

function CommandBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ border: "1px solid #dbe3e7", borderRadius: 10, overflow: "hidden", background: "#0f172a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#cbd5e1", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.10em" }}>
        {title}
        <button type="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })} style={{ border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.08)", color: "#fff", borderRadius: 7, padding: "4px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{ margin: 0, padding: 12, color: "#e2e8f0", fontSize: 12, lineHeight: 1.55, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</pre>
    </div>
  );
}

function ResultPanel({ result, onClear }: { result: JsonResult; onClear: () => void }) {
  if (result.kind === "idle") return null;
  const ok = result.kind === "ok";
  return (
    <section style={{ position: "fixed", right: 24, bottom: 24, zIndex: 50, width: 460, maxWidth: "calc(100vw - 48px)", borderRadius: 12, border: `1px solid ${ok ? "rgba(22,101,52,0.26)" : "rgba(185,28,28,0.28)"}`, background: "#fff", boxShadow: "0 18px 45px rgba(15,23,42,0.18)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--color-outline-variant)", color: ok ? "#15803d" : "#b91c1c", fontWeight: 900 }}>
        {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        {ok ? "Action completed" : "Action failed"}
        <button type="button" onClick={onClear} style={{ marginLeft: "auto", border: 0, background: "transparent", cursor: "pointer", color: "var(--color-outline)" }}><XCircle size={15} /></button>
      </div>
      <pre style={{ margin: 0, maxHeight: 280, overflow: "auto", padding: 12, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {ok ? JSON.stringify(result.value, null, 2) : result.message}
      </pre>
    </section>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 13,
  color: "var(--color-text)",
  background: "#fff",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 110,
  fontFamily: "var(--font-mono)",
  lineHeight: 1.5,
};

const iconWell: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 11,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--color-primary)",
  background: "var(--color-primary-dim)",
  border: "1px solid rgba(54,135,39,0.20)",
};

const mutedText: CSSProperties = { margin: 0, color: "var(--color-outline)", fontSize: 13, lineHeight: 1.55 };
const smallMuted: CSSProperties = { margin: "5px 0 0", color: "var(--color-outline)", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" };
const rowCard: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  border: "1px solid var(--color-outline-variant)",
  borderRadius: 10,
  padding: 12,
  background: "#fff",
};
