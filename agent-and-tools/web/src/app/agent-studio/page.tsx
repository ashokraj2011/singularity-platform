import { redirect } from "next/navigation";

// Legacy path. The Agent Studio page now lives canonically at /agents/studio
// (the path the nav, dashboard, and control-plane use). Kept as a redirect so
// old links/bookmarks still resolve.
export default function AgentStudioLegacyRedirect() {
  redirect("/agents/studio");
}
