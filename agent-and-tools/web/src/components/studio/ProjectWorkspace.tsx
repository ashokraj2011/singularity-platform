"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { workgraphFetch } from "@/lib/workgraph";
import { projectIdeTokens } from "./projectIdeTokens";
import { ProjectAnalysisSurface } from "./ProjectAnalysisSurface";
import { ProjectRequirementsSurface } from "./ProjectRequirementsSurface";
import { ProjectDesignSurface } from "./ProjectDesignSurface";
import { ProjectReconciliationReport } from "./ProjectReconciliationReport";
import { ProjectRoomsSurface } from "./ProjectRoomsSurface";
import { ProjectBoardSurface } from "./ProjectBoardSurface";
import { CoeditCanvas } from "./CoeditCanvas";
import { ProjectWorkItemsList } from "./ProjectWorkItemsList";

/**
 * The top-level Project workspace: the project IS the surface, and all its activities —
 * analysis, requirements, design, rooms, board, co-edit — live here as primary navigation.
 * Work Items are downstream: they're GENERATED from the project's locked spec (the Work
 * Items view lists them; the generation authoring flow lands in a follow-up). This inverts
 * the old model where these surfaces were buried under a Work Item's "Project baseline" scope.
 */
type Activity = "analysis" | "requirements" | "design" | "rooms" | "board" | "coedit" | "reconciliation" | "workitems";
const ACTIVITIES: { key: Activity; label: string }[] = [
  { key: "analysis", label: "Analysis" },
  { key: "requirements", label: "Requirements" },
  { key: "design", label: "Design" },
  { key: "rooms", label: "Rooms" },
  { key: "board", label: "Board" },
  { key: "coedit", label: "Co-edit" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "workitems", label: "Work Items" },
];

interface ProjectHeader { id: string; code: string; name: string; mission?: string | null; workItemCount?: number }

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectHeader | null>(null);
  const [activity, setActivity] = useState<Activity>("requirements");

  useEffect(() => {
    let active = true;
    workgraphFetch<ProjectHeader>(`/studio/projects/${projectId}`)
      .then((p) => { if (active) setProject(p); })
      .catch(() => { /* ignore */ });
    return () => { active = false; };
  }, [projectId]);

  const tokens = useMemo(() => projectIdeTokens("light") as CSSProperties, []);

  return (
    <div style={{ ...tokens, display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <header style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.08em", color: "var(--color-outline)" }}>PROJECT</span>
            {project && <span style={codeChip}>{project.code}</span>}
          </div>
          <h1 style={{ margin: "3px 0 0", fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>{project?.name ?? "Project"}</h1>
          {project?.mission && <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--color-outline)", maxWidth: 720 }}>{project.mission}</p>}
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{project?.workItemCount ?? "—"}</div>
          <div style={{ fontSize: 10.5, color: "var(--color-outline)" }}>work items generated</div>
        </div>
      </header>

      <div style={{ display: "flex", gap: 0, flex: 1, minHeight: 0 }}>
        <nav style={navStyle}>
          {ACTIVITIES.map((a) => (
            <button key={a.key} onClick={() => setActivity(a.key)} style={navItem(activity === a.key)}>{a.label}</button>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "18px 20px" }}>
          {activity === "analysis" && <ProjectAnalysisSurface projectId={projectId} />}
          {activity === "requirements" && <ProjectRequirementsSurface projectId={projectId} />}
          {activity === "design" && <ProjectDesignSurface projectId={projectId} />}
          {activity === "reconciliation" && <ProjectReconciliationReport projectId={projectId} />}
          {activity === "rooms" && <ProjectRoomsSurface projectId={projectId} />}
          {activity === "board" && <ProjectBoardSurface projectId={projectId} />}
          {activity === "coedit" && (
            <CoeditCanvas projectId={projectId} docKey="canvas" surface="coedit" title="Project canvas — live" placeholder="Draft the spec together — problem statements, open questions, sketches. Edits merge live." />
          )}
          {activity === "workitems" && <ProjectWorkItemsList projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}

const headerStyle: CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 16, padding: "16px 20px",
  borderBottom: "1px solid var(--color-outline-variant)", background: "var(--color-surface)",
};
const codeChip: CSSProperties = {
  fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 6, fontVariantNumeric: "tabular-nums",
  background: "var(--color-surface-container-high, rgba(15,23,42,0.06))", color: "var(--color-on-surface)",
};
const navStyle: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 2, width: 168, flexShrink: 0, padding: "14px 10px",
  borderRight: "1px solid var(--color-outline-variant)", background: "var(--color-surface)",
};
function navItem(active: boolean): CSSProperties {
  return {
    textAlign: "left", fontSize: 12.5, fontWeight: active ? 650 : 500, padding: "7px 11px", borderRadius: 8,
    border: "none", cursor: "pointer",
    background: active ? "var(--color-primary, #6366f1)" : "transparent",
    color: active ? "#fff" : "var(--color-on-surface)",
  };
}
