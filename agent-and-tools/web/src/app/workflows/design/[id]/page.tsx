import { LegacyWorkflowDesignRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";

export default async function WorkflowDesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LegacyWorkflowDesignRoute workflowId={id} />;
}
