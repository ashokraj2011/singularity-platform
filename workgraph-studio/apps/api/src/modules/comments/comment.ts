/**
 * Collaboration — the pure comment helpers: extracting @mentions from a body and threading a flat
 * comment list into roots + replies. No I/O.
 */

/** Extract distinct @mention handles from a comment body. */
export function parseMentions(body: string): string[] {
  const set = new Set<string>()
  const re = /(?:^|\s)@([a-zA-Z0-9._-]{2,60})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) set.add(m[1])
  return [...set]
}

export interface Threaded<T> { comment: T; replies: T[] }

/** Group a flat, chronologically-ordered comment list into roots with their direct replies. */
export function threadComments<T extends { id: string; parentId?: string | null }>(comments: T[]): Threaded<T>[] {
  const repliesByParent = new Map<string, T[]>()
  const roots: T[] = []
  for (const c of comments) {
    if (c.parentId) {
      if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, [])
      repliesByParent.get(c.parentId)!.push(c)
    } else {
      roots.push(c)
    }
  }
  return roots.map((comment) => ({ comment, replies: repliesByParent.get(comment.id) ?? [] }))
}
