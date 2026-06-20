import { LegacyWorkDetailRoute } from "@/components/workflows/LegacyWorkgraphAdminRoute";

export default function WorkflowWorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <WorkflowWorkDetailRoute params={params} searchParams={searchParams} />;
}

async function WorkflowWorkDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedSearchParams ?? {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, item));
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  return <LegacyWorkDetailRoute kind={resolvedParams.kind} id={resolvedParams.id} query={query.toString()} />;
}
