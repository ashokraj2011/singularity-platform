import { LegacyWorkflowDesignRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";

export default async function WorkflowDesignPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params;
  return <LegacyWorkflowDesignRoute workflowId={workflowId} />;
}
