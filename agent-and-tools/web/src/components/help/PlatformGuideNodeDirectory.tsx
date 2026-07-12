"use client";

import { useMemo, useState } from "react";
import { BookOpen, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { GUIDE_CATEGORIES, GUIDE_NODE_ORDER, GUIDE_NODES } from "@/lib/platformGuide";

export function PlatformGuideNodeDirectory() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return GUIDE_NODE_ORDER.map((key) => GUIDE_NODES[key]).filter((guide) => {
      if (category !== "all" && guide.category !== category) return false;
      if (!needle) return true;
      return [guide.key, guide.label, guide.category, guide.summary, guide.whenToUse, guide.execution, guide.output, guide.configuration.join(" "), guide.caution ?? "", guide.example ?? ""]
        .join(" ").toLowerCase().includes(needle);
    });
  }, [category, query]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(190px, 240px)", gap: 8 }}>
        <label style={{ position: "relative", display: "block" }}>
          <Search size={15} style={{ position: "absolute", left: 10, top: 11, color: "var(--color-outline)" }} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes, inputs, outputs, or failure behavior" aria-label="Search workflow node help" style={{ width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px 9px 31px", background: "#fff", color: "var(--color-on-surface)", fontSize: 12 }} />
        </label>
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter workflow node help by category" style={{ width: "100%", border: "1px solid var(--color-outline-variant)", borderRadius: 8, padding: "9px 11px", background: "#fff", color: "var(--color-on-surface)", fontSize: 12 }}>
          <option value="all">All node categories</option>
          {GUIDE_CATEGORIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </div>
      <div style={{ color: "var(--color-outline)", fontSize: 12 }}>{visibleNodes.length} node guides · Select a node in the designer to see the same explanation beside its configuration.</div>
      <div style={{ display: "grid", gap: 8 }}>
        {visibleNodes.map((guide) => (
          <details key={guide.key} id={`node-${guide.key}`} style={{ border: "1px solid var(--color-outline-variant)", borderRadius: 8, background: "#fff", scrollMarginTop: 24 }}>
            <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 10, padding: "12px 13px" }}>
              <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", borderRadius: 7, background: "var(--accent-workflow-soft)", color: "var(--accent-workflow)", flexShrink: 0 }}><BookOpen size={14} /></span>
              <span style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", color: "var(--color-on-surface)", fontSize: 13 }}>{guide.label}</strong><span style={{ color: "var(--color-outline)", fontSize: 11 }}>{guide.key} · {guide.summary}</span></span>
              <span style={{ color: "var(--color-outline)", flexShrink: 0 }}><ChevronDown size={15} /></span>
            </summary>
            <div style={{ borderTop: "1px solid var(--color-outline-variant)", padding: "12px 13px 14px", display: "grid", gap: 11, fontSize: 12, lineHeight: 1.55, color: "var(--color-outline)" }}>
              <div><strong style={{ color: "var(--color-on-surface)" }}>When to use:</strong> {guide.whenToUse}</div>
              <div><strong style={{ color: "var(--color-on-surface)" }}>Execution:</strong> {guide.execution}</div>
              <div><strong style={{ color: "var(--color-on-surface)" }}>Configuration:</strong><ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>{guide.configuration.map((item) => <li key={item}>{item}</li>)}</ul></div>
              <div><strong style={{ color: "var(--color-on-surface)" }}>Output:</strong> {guide.output}</div>
              {guide.example && <div style={{ padding: "8px 9px", borderRadius: 6, background: "var(--color-surface-container)", color: "var(--color-on-surface)" }}><strong>Example:</strong> {guide.example}</div>}
              {guide.caution && <div style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "8px 9px", borderRadius: 6, border: "1px solid #fde68a", background: "#fffbeb", color: "#92400e" }}><ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span><strong>Watch for:</strong> {guide.caution}</span></div>}
            </div>
          </details>
        ))}
        {visibleNodes.length === 0 && <div className="empty-state">No node help matches that search.</div>}
      </div>
    </div>
  );
}
