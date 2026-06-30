import { RequireSuperAdmin } from "@/components/RequireSuperAdmin";
import { GitConnectionsConsole } from "@/components/git/GitConnectionsConsole";

export default function GitConnectionsPage() {
  return (
    <RequireSuperAdmin>
      <GitConnectionsConsole />
    </RequireSuperAdmin>
  );
}
