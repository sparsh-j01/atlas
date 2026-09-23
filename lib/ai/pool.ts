/**
 * Run `fn` over `items` at most `limit` at a time until `need` of them succeed (`ok`).
 * Items past `need` are spares: one starts only when an earlier item fails, so a clean run
 * never touches them. Results come back in input order; an item never started is absent.
 *
 * Shared by both generation routes. Free-tier requests-per-minute is the binding
 * constraint on how wide a wave can be — a wider pool just collects 429s.
 */
export async function fillPool<T, R>(
  items: T[],
  need: number,
  limit: number,
  fn: (item: T) => Promise<R>,
  ok: (result: R) => boolean,
): Promise<R[]> {
  const results = new Array<R | undefined>(items.length)
  let next = 0
  let succeeded = 0
  let inFlight = 0
  async function worker() {
    // Counting in-flight items as successes until they finish is what keeps spares idle:
    // a worker only reaches past `need` once something it was counting on has failed.
    while (next < items.length && succeeded + inFlight < need) {
      const i = next++
      inFlight++
      const result = await fn(items[i])
      inFlight--
      if (ok(result)) succeeded++
      results[i] = result
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results.filter((r): r is R => r !== undefined)
}
