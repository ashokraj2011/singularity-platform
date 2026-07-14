import { StudioProjectDetail } from "@/components/studio/StudioProjectDetail";

export default async function StudioProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <StudioProjectDetail projectId={projectId} />;
}
