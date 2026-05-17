"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, RefreshCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import { authHeaders, runtimeApi } from "@/lib/api";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: string;
};
type ActionIntent = "explain_capability" | "find_runtime_evidence" | "draft_review_note" | "recommend_agent_team" | "explain_prompt_stack";

type ContextSnapshot = {
  app: string;
  path: string;
  surface: string;
  capability?: Record<string, unknown> | null;
  actionIntent?: ActionIntent | null;
  hints: string[];
};

const SESSION_KEY = "event-horizon.agent-tools.session";
const SESSION_ID_KEY = "event-horizon.agent-tools.session-id";
const DEFAULT_CAPABILITY_ID = process.env.NEXT_PUBLIC_EVENT_HORIZON_CAPABILITY_ID ?? "00000000-0000-0000-0000-00000000aaaa";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function greeting(path: string): ChatMessage {
  return {
    id: newId(),
    role: "assistant",
    text: `I am Event Horizon. I can help with this Agent Runtime screen, explain capability setup, agent versions, prompt layers, tools, and what to check next. Current path: ${path}.`,
    createdAt: new Date().toISOString(),
  };
}

function surfaceFor(path: string): string {
  if (path.startsWith("/capabilities/")) return "Capability Detail";
  if (path.startsWith("/capabilities")) return "Capabilities";
  if (path.startsWith("/agent-studio")) return "Agent Studio";
  if (path.startsWith("/tools")) return "Tools";
  if (path.startsWith("/prompt-workbench")) return "Prompt Workbench";
  if (path.startsWith("/prompt-profiles")) return "Agent Behavior Profiles";
  if (path.startsWith("/prompt-layers")) return "Prompt Layers";
  if (path.startsWith("/runtime-executions")) return "Runtime Receipts";
  return "Agent Runtime";
}

function extractCapabilityId(path: string): string | null {
  const [, section, id] = path.split("/");
  if (section === "capabilities" && UUID_RE.test(id ?? "")) return id;
  return null;
}

function formatCapability(capability?: Record<string, unknown> | null): string {
  if (!capability) return "No capability is selected on this screen.";
  const name = String(capability.name ?? capability.id ?? "selected capability");
  const status = String(capability.status ?? "unknown");
  const criticality = capability.criticality ? ` Criticality: ${capability.criticality}.` : "";
  return `Capability: ${name}. Status: ${status}.${criticality}`;
}

function answer(question: string, ctx: ContextSnapshot): string {
  const q = question.toLowerCase();
  if (q.includes("clear") || q.includes("fresh") || q.includes("reset")) {
    return "Use Clear session in this panel. I will forget this local conversation and start fresh with only the current page context.";
  }
  if (q.includes("capability")) {
    return `${formatCapability(ctx.capability)} Capability screens are where runtime agents, bindings, repos, knowledge, code, sources, and bootstrap review live. Bootstrap-created agents remain draft until reviewed or activated.`;
  }
  if (q.includes("agent") || q.includes("version")) {
    return "Agent Studio now separates common locked templates from capability agents. Editable templates keep version history, and saving an edit creates a new restorable version.";
  }
  if (q.includes("tool") || q.includes("wizard")) {
    return "Tools are created through the Tool Creation Wizard: identity, schema contract, runtime target, then governance. LOCAL targets run near MCP; SERVER targets route through the governed tool-service path.";
  }
  if (q.includes("prompt") || q.includes("layer")) {
    return "Prompt Profiles are behavior presets. Prompt Layers remain editable for platform/admin work, while profiles group layers into readable runtime sections and audit metadata.";
  }
  if (q.includes("where") || q.includes("screen") || q.includes("context")) {
    return `You are in ${ctx.app}, surface ${ctx.surface}, path ${ctx.path}. ${ctx.hints.join(" ")}`;
  }
  if (q.includes("status") || q.includes("workflow") || q.includes("run")) {
    return "Workflow execution status is owned by Workflow Manager. Open the Workflow Manager or Run Insights to see active runs, node status, budgets, events, citations, and branch/commit evidence.";
  }
  return `For this ${ctx.surface} screen: ${ctx.hints.join(" ")} Ask me about capability setup, agent versions, tool creation, prompt layers, runtime receipts, or where to inspect workflow status.`;
}

// M37.4 — Quick-action buttons used to be a hardcoded ACTIONS array here.
// Now fetched from /api/event-horizon/actions?surface=capability-admin which
// proxies to prompt-composer (singularity_composer DB, EventHorizonAction
// table). Edit a row + re-seed; SPA picks it up on next mount, no rebuild.
type EventHorizonActionRow = {
  id: string;
  surface: string;
  intent: string;
  label: string;
  prompt: string;
  displayOrder: number;
};

function mapActionIntent(intent: ActionIntent | null): "find_evidence" | "draft_approval_note" | "recommend_budget_model" | undefined {
  if (intent === "find_runtime_evidence") return "find_evidence";
  if (intent === "draft_review_note") return "draft_approval_note";
  if (intent === "recommend_agent_team" || intent === "explain_prompt_stack" || intent === "explain_capability") return "recommend_budget_model";
  return undefined;
}

export function EventHorizonChat() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [thinking, setThinking] = useState(false);
  // M37.4 — quick-action buttons fetched from /api/event-horizon/actions
  // (was hardcoded ACTIONS array). Empty array on cold start; populated on
  // first mount. If the fetch fails, the chat still works without buttons.
  const [actions, setActions] = useState<EventHorizonActionRow[]>([]);
  const [ctx, setCtx] = useState<ContextSnapshot>(() => ({
    app: "Agent Runtime",
    path: pathname,
    surface: surfaceFor(pathname),
    hints: ["Use this utility to manage capability runtime assets, agents, tools, prompt profiles, and audit-ready execution evidence."],
  }));
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const capabilityId = useMemo(() => extractCapabilityId(pathname), [pathname]);

  function activeSessionId(): string {
    if (sessionId) return sessionId;
    const fresh = newId();
    localStorage.setItem(SESSION_ID_KEY, fresh);
    setSessionId(fresh);
    return fresh;
  }

  // M37.4 — fetch the EventHorizonAction catalog once on first mount.
  useEffect(() => {
    fetch("/api/event-horizon/actions?surface=capability-admin")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setActions(Array.isArray(data) ? data : []))
      .catch((err) => console.warn("[EventHorizonChat] failed to load action catalog:", err));
  }, []);

  useEffect(() => {
    const existingSession = localStorage.getItem(SESSION_ID_KEY);
    if (existingSession) {
      setSessionId(existingSession);
    } else {
      const fresh = newId();
      localStorage.setItem(SESSION_ID_KEY, fresh);
      setSessionId(fresh);
    }
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed);
          return;
        }
      } catch {
        // ignore corrupt local session
      }
    }
    setMessages([greeting(pathname)]);
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(messages));
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const next: ContextSnapshot = {
        app: "Agent Runtime",
        path: pathname,
        surface: surfaceFor(pathname),
        hints: ["I can explain what this screen does and point you to related governance/runtime evidence."],
      };
      if (capabilityId) {
        try {
          next.capability = await runtimeApi.getCapability(capabilityId);
          next.hints.push(formatCapability(next.capability));
        } catch {
          next.hints.push(`Capability ${capabilityId} is in the URL, but I could not load details right now.`);
        }
      }
      if (pathname.startsWith("/agent-studio")) next.hints.push("This is where agent lineage, editability, and version history are maintained.");
      if (pathname.startsWith("/tools")) next.hints.push("This is where tools are registered, activated, risk-classified, and approval-gated.");
      if (pathname.startsWith("/prompt-workbench")) next.hints.push("This is where prompt drafts, model aliases, token budgets, and Composer context plans are compared before execution.");
      if (pathname.startsWith("/prompt")) next.hints.push("Prompt surfaces control behavior presets, layer content, and auditability.");
      if (!cancelled) setCtx(next);
    }
    void load();
    return () => { cancelled = true; };
  }, [capabilityId, pathname]);

  async function callEventHorizon(text: string, actionIntent?: ActionIntent | null): Promise<string> {
    const sid = activeSessionId();
    const capability = (ctx.capability?.id ?? ctx.capability?.capabilityId ?? ctx.capability?.capability_id ?? capabilityId ?? DEFAULT_CAPABILITY_ID) as string;
    const res = await fetch("/api/workgraph/event-horizon/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        message: text,
        sessionId: sid,
        app: ctx.app,
        surface: ctx.surface,
        path: ctx.path,
        capabilityId: capability,
        actionIntent: mapActionIntent(actionIntent ?? ctx.actionIntent ?? null),
        context: { ...ctx, actionIntent: actionIntent ?? ctx.actionIntent ?? null },
      }),
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new Error(raw.slice(0, 300) || `Event Horizon returned ${res.status}`);
    }
    const json = await res.json() as { response?: string; status?: string };
    return json.response || `Event Horizon completed with status ${json.status ?? "UNKNOWN"}, but returned no text.`;
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    const user: ChatMessage = { id: newId(), role: "user", text, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, user]);
    setInput("");
    setThinking(true);
    try {
      const llmText = await callEventHorizon(text);
      setMessages((m) => [...m, { id: newId(), role: "assistant", text: llmText, createdAt: new Date().toISOString() }]);
    } catch (err) {
      setMessages((m) => [...m, {
        id: newId(),
        role: "assistant",
        text: `${answer(text, ctx)}\n\nContext Fabric/MCP call failed: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setThinking(false);
    }
  }

  async function sendAction(intent: ActionIntent, prompt: string) {
    setCtx((c) => ({ ...c, actionIntent: intent }));
    const user: ChatMessage = { id: newId(), role: "user", text: prompt, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, user]);
    setThinking(true);
    try {
      const llmText = await callEventHorizon(prompt, intent);
      setMessages((m) => [...m, { id: newId(), role: "assistant", text: llmText, createdAt: new Date().toISOString() }]);
    } catch (err) {
      setMessages((m) => [...m, {
        id: newId(),
        role: "assistant",
        text: `${answer(prompt, { ...ctx, actionIntent: intent })}\n\nContext Fabric/MCP call failed: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setThinking(false);
      setCtx((c) => ({ ...c, actionIntent: null }));
    }
  }

  function clear() {
    const freshId = newId();
    const fresh = greeting(pathname);
    localStorage.setItem(SESSION_ID_KEY, freshId);
    localStorage.removeItem(SESSION_KEY);
    setSessionId(freshId);
    setMessages([fresh]);
  }

  return (
    <div className="fixed bottom-5 right-5 z-[80]">
      {open ? (
        <div className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-2xl">
          <div className="bg-[linear-gradient(135deg,#082821,#0E3B2D)] p-4 text-white">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold">
                  <Sparkles size={16} /> Event Horizon
                </div>
                <div className="mt-1 text-xs text-emerald-100">{ctx.surface} · {ctx.app}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={clear} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Clear session">
                  <Trash2 size={14} />
                </button>
                <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Close">
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
          <div className="max-h-[420px] space-y-3 overflow-y-auto bg-slate-50 p-4">
            <div className="flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <button
                  key={action.intent}
                  type="button"
                  onClick={() => void sendAction(action.intent as ActionIntent, action.prompt)}
                  disabled={thinking}
                  className="rounded-full border border-emerald-200 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === "user" ? "bg-emerald-700 text-white" : "border border-slate-200 bg-white text-slate-700"}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                  Event Horizon is routing through Context Fabric and MCP...
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-slate-200 bg-white p-3">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
                placeholder="Ask about this screen..."
                className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              />
              <button onClick={() => void send()} disabled={thinking} className="rounded-xl bg-emerald-700 px-3 py-2 text-white hover:bg-emerald-800 disabled:opacity-50" title="Send">
                <Send size={16} />
              </button>
            </div>
            <button onClick={clear} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800">
              <RefreshCcw size={12} /> Clear session and start fresh
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="group flex items-center gap-2 rounded-full border border-emerald-200 bg-[linear-gradient(135deg,#082821,#0E3B2D)] px-4 py-3 text-sm font-bold text-white shadow-xl transition hover:scale-[1.02]"
        >
          <Bot size={18} className="text-emerald-200" />
          Event Horizon
        </button>
      )}
    </div>
  );
}
