import { redirect } from "next/navigation";

// /agents is a back-compat alias. The Agent Studio workbench (M23 — it replaced
// the legacy flat /agents + /agent-templates lists) now lives canonically at
// /agents/studio, which is what the nav, dashboard, and control-plane link to.
export default function AgentsAliasRedirect() {
  redirect("/agents/studio");
}
