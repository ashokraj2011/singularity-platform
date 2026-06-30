import type { Metadata } from "next";
import Link from "next/link";
import {
  BookOpen, Rocket, Bot, GitBranch, Wrench, Workflow, Users,
  ShieldCheck, Activity, Network, LifeBuoy, Lightbulb,
} from "lucide-react";
import { PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "User Guide & Help · Singularity Platform",
  description: "How to use the Singularity Platform — concepts, key flows, and troubleshooting.",
};

// Static, self-contained user guide. Server component (no client state) — every
// cross-link points at a real route in the sidebar so the guide stays a live map
// of the product rather than a separate doc that drifts.

type TocItem = { id: string; label: string };
const TOC: TocItem[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "concepts", label: "Core concepts" },
  { id: "agent-studio", label: "Agent Studio" },
  { id: "capabilities", label: "Capabilities & onboarding" },
  { id: "tools", label: "Tools & grants" },
  { id: "workflows", label: "Workflows & Workbench" },
  { id: "identity", label: "Identity & access" },
  { id: "governance", label: "Governance & FinOps" },
  { id: "operations", label: "Operations & health" },
  { id: "runtimes", label: "Runtimes (advanced)" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "help", label: "Getting help" },
];

function Section({
  id, icon: Icon, title, children,
}: { id: string; icon: typeof Bot; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-950">
        <Icon size={18} className="text-emerald-700" />
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-slate-700">{children}</div>
    </section>
  );
}

const linkCls = "font-medium text-emerald-700 underline decoration-emerald-200 underline-offset-2 hover:decoration-emerald-500";

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Hero — uses the shared PageHeader primitive */}
      <PageHeader
        eyebrow="User Guide"
        icon={BookOpen}
        title="Platform Web — User Guide & Help"
        description={
          <>
            Singularity Platform is one portal to <strong>design, govern, and run AI agents</strong> against
            your capabilities — with end-to-end grounding, tool governance, and audit. This guide explains the
            core concepts, the most common flows, and how to get unstuck.
          </>
        }
      />

      {/* TOC */}
      <nav className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">On this page</div>
        <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {TOC.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className={linkCls}>{t.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="getting-started" icon={Rocket} title="Getting started">
        <p>
          <strong>Sign in once.</strong> The portal uses your IAM session — a single sign-in governs agents,
          tools, workflows, and identity. On a local stack the bootstrap admin is{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-[12px]">admin@singularity.local</code>. To switch
          users or force a fresh login, use the <strong>Logout</strong> button in the top bar (a stack restart
          does not clear your session — it lives in your browser).
        </p>
        <p>
          <strong>Navigate</strong> from the left sidebar, grouped by area. <Link href="/" className={linkCls}>Command
          Center</Link> is your overview; the <Link href="/control-plane" className={linkCls}>App Catalog</Link> lists
          every surface; <Link href="/start" className={linkCls}>Start SDLC Work</Link> kicks off a guided run.
        </p>
      </Section>

      <Section id="concepts" icon={Lightbulb} title="Core concepts">
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Capability</strong> — the organizing unit: a business capability (e.g. an app or service) with its repositories, knowledge, bound agents, tools, and governance.</li>
          <li><strong>Agent</strong> — a governed template that does work. Either a common locked baseline or a capability-derived (editable) agent. Managed in Agent Studio.</li>
          <li><strong>Tool</strong> — a registered, governed action an agent can invoke (read, search, apply a patch, run a command, commit, call an API…). Each has a risk level and may require approval.</li>
          <li><strong>Workflow</strong> — a graph of nodes (including governance gates) that orchestrates agents and tools — e.g. the SDLC delivery loop.</li>
          <li><strong>World model / grounding</strong> — a capability&apos;s distilled repo + knowledge context that grounds its agents at run time.</li>
          <li><strong>Governance</strong> — per-stage and per-gate controls (advisory / required / blocking), waivers, and short-lived signed tool grants that bind a tool call to a specific run.</li>
        </ul>
      </Section>

      <Section id="agent-studio" icon={Bot} title="Agent Studio">
        <p>
          <Link href="/agents/studio" className={linkCls}>Agent Studio</Link> is where you create and manage agents:
          common locked baselines and capability-derived agents, with prompt bindings, lineage, and version history.
        </p>
        <p>
          Use <strong>Create Agent</strong> to add one, pick a capability to scope it, and derive from a baseline
          when you want an editable, capability-specific agent. Behaviour and prompts live under{" "}
          <Link href="/prompt-workbench" className={linkCls}>Prompts &amp; Knowledge</Link>.
        </p>
      </Section>

      <Section id="capabilities" icon={GitBranch} title="Capabilities & onboarding">
        <p>
          Open <Link href="/capabilities" className={linkCls}>Capabilities</Link> to onboard and manage capabilities.
          Onboarding (bootstrap) takes a name, app id, one or more repositories, and knowledge sources, then
          <strong> discovers</strong> the repo to ground the agents.
        </p>
        <p className="font-semibold text-slate-900">The onboarding flow:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Bootstrap the capability (name + repo + knowledge).</li>
          <li><strong>Review &amp; approve</strong> the bootstrap learning candidates — ingestion is governance-gated, so nothing is grounded until you approve.</li>
          <li>Approval materializes knowledge artifacts; the <strong>Primary stack</strong> is then inferred from the ingested repo content (e.g. Java / Maven), and the world model grounds the agents.</li>
        </ol>
        <p>
          <strong>Refresh learning</strong> (on the capability page) re-ingests approved repos/knowledge and
          re-grounds the world model. If you see <em>&quot;Stack pending&quot;</em> or a redistill <em>conflict</em>,
          it means nothing is ingested yet — approve the bootstrap candidates first, then Refresh learning.
        </p>
      </Section>

      <Section id="tools" icon={Wrench} title="Tools & grants">
        <p>
          The <Link href="/tools" className={linkCls}>Tools</Link> registry lists every registered tool with its
          risk level, approval requirement, and execution target (LOCAL on a runtime vs SERVER). Core tools (read,
          search, apply_patch, git_commit, http_get, …) are seeded automatically.
        </p>
        <p>
          <Link href="/tool-grants" className={linkCls}>Tool Grants</Link> are short-lived, signed authorizations
          that bind a single tool call to a specific run, node, and arguments — high-risk and mutating tools
          require one.
        </p>
      </Section>

      <Section id="workflows" icon={Workflow} title="Workflows & Workbench">
        <p>
          <Link href="/workflows" className={linkCls}>Workflows</Link> is where you plan, launch, and monitor runs —
          Story Planner, Guided Launch, Run History, and live Runs. The{" "}
          <Link href="/workbench" className={linkCls}>Blueprint Workbench</Link> is the in-portal cockpit for SDLC work.
        </p>
        <p>
          A run advances through stages; a <strong>governance gate</strong> can block or pause it pending an approval
          or waiver. The run cockpit shows what blocked it and the evidence behind each decision.
        </p>
      </Section>

      <Section id="identity" icon={Users} title="Identity & access">
        <p>
          <Link href="/identity" className={linkCls}>Identity</Link> manages users, teams, business units, roles,
          permissions, capability access, and sharing grants — plus an identity audit log. Sign-in supports local
          credentials and SSO/OIDC.
        </p>
      </Section>

      <Section id="governance" icon={ShieldCheck} title="Governance & FinOps">
        <p>
          Under <strong>Governance &amp; FinOps</strong> you author and observe controls: the policy{" "}
          <Link href="/engine" className={linkCls}>Engine</Link>, <Link href="/llm-settings" className={linkCls}>LLM
          routing</Link>, the <Link href="/audit" className={linkCls}>Audit</Link> ledger, eval curation, and{" "}
          <Link href="/cost" className={linkCls}>Cost</Link>. Governance gates in a workflow enforce these controls
          at run time (advisory / required / blocking) with waivers recorded as evidence.
        </p>
      </Section>

      <Section id="operations" icon={Activity} title="Operations & health">
        <p>
          <Link href="/operations/readiness" className={linkCls}>Operations</Link> shows live system health:
          Readiness, the <Link href="/operations/architecture" className={linkCls}>Live App Map</Link>, Access Keys,
          the Setup Center, and Trust Evidence. Check here first if a surface looks empty or a run stalls.
        </p>
      </Section>

      <Section id="runtimes" icon={Network} title="Runtimes (advanced)">
        <p>
          Agent work executes on <strong>MCP + LLM runtimes</strong> that connect to the Context Fabric over a
          bridge. Identity is token-authoritative: every runtime carries a <strong>unique runtime id</strong> in its
          token. You can deploy <strong>all-in-one</strong> (everything local) or <strong>split</strong> — run the
          MCP + LLM on your laptop and the control plane in the cloud, so provider keys never leave your machine.
        </p>
        <p>
          Avoid running two runtimes under the same id (they evict each other). If tool/model dispatch stalls, check
          the runtime registry in Operations.
        </p>
      </Section>

      <Section id="troubleshooting" icon={LifeBuoy} title="Troubleshooting">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4">Symptom</th>
                <th className="py-2">What it means &amp; what to do</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">Capability shows &quot;Stack pending&quot;</td>
                <td className="py-2">The repo isn&apos;t ingested yet. Approve the bootstrap learning candidates, then use <strong>Refresh learning</strong>.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">&quot;Conflict&quot; when grounding a capability</td>
                <td className="py-2">The world-model redistill has nothing to distill (no ingested README/code). Ingest the repo first (approve + Refresh learning).</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">Portal didn&apos;t ask for login after a restart</td>
                <td className="py-2">Your session token lives in the browser and survives stack restarts. Click <strong>Logout</strong> to force a fresh sign-in.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">A page asks you to sign in again mid-session</td>
                <td className="py-2">Your token expired or is stale. Sign in again at the front door; you won&apos;t see a separate per-page login.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">Tools page is empty</td>
                <td className="py-2">You may not be signed in, or the registry isn&apos;t initialized. Sign in; if still empty, check Operations → Readiness.</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-medium text-slate-900">A run stalls / tools won&apos;t dispatch</td>
                <td className="py-2">A runtime may be offline or colliding. Check the runtime registry in <Link href="/operations/readiness" className={linkCls}>Operations</Link>.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="help" icon={LifeBuoy} title="Getting help">
        <p>
          Start with <Link href="/operations/readiness" className={linkCls}>Operations → Readiness</Link> for system
          health and the <Link href="/audit" className={linkCls}>Audit</Link> ledger for recent activity. For access
          or configuration issues, contact your platform administrator.
        </p>
      </Section>
    </div>
  );
}
