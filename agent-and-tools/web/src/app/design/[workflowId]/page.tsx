import { redirect } from "next/navigation";

export default async function LegacyWorkflowDesignPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params;
  redirect(`/workflows/design/${workflowId}`);
}
