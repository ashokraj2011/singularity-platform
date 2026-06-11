// ONE list-unwrap for every paginated/legacy API shape. The API returns either a
// bare array, toPageResponse's { content: [...] }, or the legacy { items: [...] }
// — this helper replaces the four hand-rolled defensive patterns that grew in
// RunGraphView / RunViewerPage / ArtifactsExplorerPage (and caused the
// "no artifacts" bug when one of them guessed the wrong key).
export function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  const o = data as { content?: T[]; items?: T[]; data?: T[] } | null | undefined
  if (Array.isArray(o?.content)) return o.content
  if (Array.isArray(o?.items)) return o.items
  if (Array.isArray(o?.data)) return o.data
  return []
}
