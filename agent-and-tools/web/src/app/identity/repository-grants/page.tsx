import { RequireSuperAdmin } from "@/components/RequireSuperAdmin";
import { RepositoryGrantsConsole } from "@/components/git/RepositoryGrantsConsole";

export default function RepositoryGrantsPage() {
  return (
    <RequireSuperAdmin>
      <RepositoryGrantsConsole />
    </RequireSuperAdmin>
  );
}
