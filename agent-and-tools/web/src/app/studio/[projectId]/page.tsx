import { redirect } from "next/navigation";

type ProjectWorkspacePageProps = {
  params?: Promise<{ projectId?: string | string[] }>;
};

export default async function ProjectWorkspacePage({ params }: ProjectWorkspacePageProps) {
  const resolvedParams = await params;
  const raw = resolvedParams?.projectId;
  const projectId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  if (!projectId) {
    redirect("/synthesis/hub");
  }
  redirect(`/synthesis/overview?project=${encodeURIComponent(projectId)}`);
}
