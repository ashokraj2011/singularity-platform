import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OperationsLogsRedirect({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = new URLSearchParams({ view: "logs" });
  const incoming = searchParams ? await searchParams : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "view" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  redirect(`/audit?${params.toString()}`);
}
