/**
 * Bounded-concurrency async map. Runs `fn` over `items` with at most `limit`
 * in flight at once, preserving input order in the result.
 *
 * Used by the Copilot-handoff exports: each runnable phase triggers a
 * context-fabric `compose-copilot-prompt` call (a repo world-model build), so an
 * unbounded `Promise.all` would amplify one export request into N concurrent
 * heavyweight CF builds. Capping concurrency bounds that fan-out.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
