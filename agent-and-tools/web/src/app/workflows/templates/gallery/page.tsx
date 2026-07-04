"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Loader2,
  RadioTower,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiPath, authHeaders, readResponseBody, responseMessage } from "@/lib/api";
import { shortId } from "@/lib/workgraph";
import { filterGalleryItems, normalizeGalleryResponse, type GalleryData, type GalleryItem } from "./gallery-model";

async function fetchGallery(): Promise<GalleryData> {
  const res = await fetch(apiPath("/api/workflow-templates/gallery"), { cache: "no-store", headers: authHeaders() });
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) throw new Error(responseMessage(parsed, raw, res.statusText));
  return normalizeGalleryResponse(parsed);
}

export default function WorkflowTemplateGalleryPage() {
  const { data, error, isLoading, mutate } = useSWR("workflow-template-gallery-page", fetchGallery, { refreshInterval: 30000 });
  const [query, setQuery] = useState("");
  const items = useMemo(() => filterGalleryItems(data?.items ?? [], query), [data?.items, query]);

  return (
    <div style={{ maxWidth: 1320 }}>
      <section className="card" style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div className="label-xs" style={{ color: "var(--color-primary)", marginBottom: 8 }}>Workflow Templates</div>
            <h1 className="page-header" style={{ marginBottom: 8 }}>SDLC Template Gallery</h1>
            <p style={{ margin: 0, maxWidth: 850, color: "var(--color-outline)", fontSize: 14, lineHeight: 1.6 }}>
              Curated launch metadata for seeded SDLC workflows: intent, inputs, agents, runtime needs, governance preset, and sample story.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={() => void mutate()} disabled={isLoading}>
              {isLoading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              Refresh
            </button>
            <Link href="/workflows/start" className="btn-primary"><GitBranch size={15} /> Guided launch</Link>
          </div>
        </div>
      </section>

      <section className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ position: "relative" }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--color-outline)" }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search intents, agents, inputs, or templates..."
            style={{ width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "10px 12px 10px 36px", fontSize: 13 }}
          />
        </div>
      </section>

      {error && (
        <section className="card" style={{ padding: 14, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b", marginBottom: 16 }}>
          {error.message}
        </section>
      )}

      {data?.referenceOnly && (
        <section className="card" style={{ padding: 14, borderColor: "#fde68a", background: "#fffbeb", color: "#92400e", marginBottom: 16 }}>
          {data.message ?? "Login is required to inspect saved workflow templates. Showing the built-in SDLC intent catalog."}
        </section>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))", gap: 14 }}>
        {items.map((item) => <GalleryCard key={item.id} item={item} referenceOnly={Boolean(data?.referenceOnly)} />)}
        {!isLoading && items.length === 0 && <Empty />}
      </section>
    </div>
  );
}

function GalleryCard({ item, referenceOnly }: { item: GalleryItem; referenceOnly: boolean }) {
  const seeded = Boolean(item.workflowTemplate?.id);
  return (
    <article className="card" style={{ padding: 18, display: "grid", gap: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 8, display: "grid", placeItems: "center", color: seeded ? "#047857" : "#b45309", background: seeded ? "#ecfdf5" : "#fffbeb" }}>
          {seeded ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
        </span>
        <span className={seeded ? "badge badge-active" : "badge badge-pending_approval"}>
          {seeded ? `${item.templateCount ?? 1} match` : referenceOnly ? "login required" : "missing seed"}
        </span>
      </div>

      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>{item.label}</h2>
        <p style={{ margin: "7px 0 0", color: "var(--color-outline)", fontSize: 13, lineHeight: 1.5 }}>{item.description}</p>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <Fact icon={GitBranch} label="Template" value={item.workflowTemplate?.name ?? (referenceOnly ? "Login to inspect" : "No seeded workflow")} muted={!seeded} />
        <Fact icon={RadioTower} label="Runtime" value={item.runtimeRequirement ?? item.runtimePreference ?? "Runtime required"} />
        <Fact icon={ShieldCheck} label="Governance" value={item.governancePreset ?? "standard"} />
        <Fact icon={Sparkles} label="Model alias" value={item.defaultModelAlias ?? "balanced"} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {(item.defaultAgents ?? []).map((agent) => <Pill key={agent}>{agent.replace(/_/g, " ")}</Pill>)}
        {(item.requiredInputs ?? []).map((input) => <Pill key={input}>{input}</Pill>)}
      </div>

      {item.sampleStory && (
        <section style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: 11, background: "var(--color-surface-container)" }}>
          <div className="label-xs" style={{ color: "var(--color-outline)", marginBottom: 5 }}>Sample story</div>
          <p style={{ margin: 0, color: "var(--color-on-surface)", fontSize: 12, lineHeight: 1.5 }}>{item.sampleStory}</p>
        </section>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href={`/workflows/start?intent=${encodeURIComponent(item.id)}`} className={seeded ? "btn-primary" : "btn-secondary"}>
          <GitBranch size={14} /> Try in launcher
        </Link>
        <Link href="/workflows/planner" className="btn-secondary">
          <ClipboardList size={14} /> Split story
        </Link>
      </div>

      {item.workflowTemplate?.id && (
        <Link href={`/workflows/design/${item.workflowTemplate.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-primary)", fontSize: 12, fontWeight: 850, textDecoration: "none" }}>
          Open template design {shortId(item.workflowTemplate.id)}
          <ArrowRight size={13} />
        </Link>
      )}
    </article>
  );
}

function Fact({ icon: Icon, label, value, muted = false }: { icon: LucideIcon; label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px 90px minmax(0, 1fr)", gap: 8, alignItems: "center", fontSize: 12 }}>
      <Icon size={14} color={muted ? "#b45309" : "var(--color-primary)"} />
      <span style={{ color: "var(--color-outline)", fontWeight: 800 }}>{label}</span>
      <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: muted ? "#b45309" : "var(--color-on-surface)" }}>{value}</strong>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return <span style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 999, padding: "4px 8px", fontSize: 11, fontWeight: 800, color: "var(--color-outline)", background: "#fff" }}>{children}</span>;
}

function Empty() {
  return (
    <section className="card" style={{ padding: 24, color: "var(--color-outline)", fontSize: 13 }}>
      No matching template intents. Clear the search or seed SDLC workflow templates.
    </section>
  );
}
