import { ArtifactEditorClient } from "./ArtifactEditorClient";

export default async function WorkflowArtifactEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArtifactEditorClient artifactId={id} />;
}
