import { describe, it, expect } from 'vitest'
import { fillPool } from '../pool'

const all = () => true

describe('fillPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await fillPool([30, 10, 20, 0], 4, 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    }, all)
    expect(out).toEqual([30, 10, 20, 0])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await fillPool(Array.from({ length: 20 }, (_, i) => i), 20, 5, async () => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 1))
      active--
    }, all)
    expect(peak).toBeLessThanOrEqual(5)
  })

  it('leaves the spares untouched when everything needed succeeds', async () => {
    const started: number[] = []
    const out = await fillPool([1, 2, 3, 4, 5], 3, 2, async (n) => (started.push(n), n), all)
    expect(started.sort()).toEqual([1, 2, 3])
    expect(out).toEqual([1, 2, 3])
  })

  it('starts a spare for each failure, in order, until enough succeed', async () => {
    // 2 and 3 fail: the deck still reaches 3 good results from spares 4 and 5.
    const out = await fillPool([1, 2, 3, 4, 5, 6], 3, 2, async (n) => n, (n) => n !== 2 && n !== 3)
    expect(out).toEqual([1, 2, 3, 4, 5])
  })

  it('returns what it got when the spares run out', async () => {
    const out = await fillPool([1, 2, 3], 3, 3, async (n) => n, (n) => n === 1)
    expect(out).toEqual([1, 2, 3])
  })

  it('handles an empty list without spawning workers', async () => {
    expect(await fillPool([], 5, 5, async () => 1, all)).toEqual([])
  })
})
