import { WorkbenchRoute } from "@/components/workbench/WorkbenchRoute";

export default function LoopTheaterPage() {
  return <WorkbenchRoute mode="theater" view="loop-theater" fallback="Loading Loop Theater..." />;
}
