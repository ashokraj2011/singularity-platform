import { OperationsStatusPage } from "@/components/OperationsStatusPage";

export default function OperationsArchitecturePage() {
  return <OperationsStatusPage view="architecture" title="System Map" description="Service topology showing one web shell, domain routes, backend APIs, Context Fabric, and runtime dial-in connections." />;
}
