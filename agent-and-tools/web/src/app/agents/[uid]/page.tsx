import AgentDetailClient from "./AgentDetailClient";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  return <AgentDetailClient uid={decodeURIComponent(uid)} />;
}
