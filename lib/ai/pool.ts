/**
 * Run `fn` over `items` at most `limit` at a time, preserving input order.
 *
 * Shared by both generation routes. Free-tier requests-per-minute is the binding
 * constraint on how wide a wave can be — a wider pool just collects 429s.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
