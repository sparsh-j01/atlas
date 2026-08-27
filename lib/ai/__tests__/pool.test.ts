import { describe, it, expect } from 'vitest'
import { mapPool } from '../pool'

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([30, 10, 20, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([30, 10, 20, 0])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 1))
      active--
    })
    expect(peak).toBeLessThanOrEqual(5)
  })

  it('handles an empty list without spawning workers', async () => {
    expect(await mapPool([], 5, async () => 1)).toEqual([])
  })

  it('handles a limit larger than the list', async () => {
    expect(await mapPool([1, 2], 99, async (n) => n * 2)).toEqual([2, 4])
  })
})
