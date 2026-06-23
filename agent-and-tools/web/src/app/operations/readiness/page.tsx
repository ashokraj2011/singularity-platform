import { OperationsStatusPage } from "@/components/OperationsStatusPage";

export default function OperationsReadinessPage() {
  return <OperationsStatusPage view="readiness" title="Platform Readiness" description="Health dashboard for required backend APIs, Context Fabric, and runtime infrastructure." />;
}
