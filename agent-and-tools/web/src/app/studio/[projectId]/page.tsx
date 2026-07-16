"use client";

import { useParams } from "next/navigation";
import { ProjectWorkspace } from "@/components/studio/ProjectWorkspace";

export default function ProjectWorkspacePage() {
  const params = useParams();
  const raw = params?.projectId;
  const projectId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  if (!projectId) return null;
  return <ProjectWorkspace projectId={projectId} />;
}
